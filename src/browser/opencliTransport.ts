import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getOracleHomeDir } from "../oracleHome.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { getSessionPaths } from "../sessionManager.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionArtifact,
} from "../sessionStore.js";
import { computeFileSha256 } from "./artifacts.js";
import { DEFAULT_BROWSER_ATTACHMENT_TIMEOUT_MS } from "./constants.js";
import { acquireProfileRunLock } from "./profileState.js";
import {
  elapsedSinceDispatch,
  recordProResponseTiming,
  verifyStoredProResponseWorkloadTiming,
} from "./proResponseTiming.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "./types.js";
import { estimateTokenCount } from "./utils.js";

const execFileAsync = promisify(execFile);
const OPENCLI_CONTRACT_VERSION = 3;
const MIN_OPENCLI_VERSION = [1, 8, 6] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 120_000;
const ORACLE_WAIT_STABLE_SECONDS = 9;
const OPENCLI_WINDOW_MODE = "background" as const;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface OpenCliFailureEvidence {
  stage?: string;
  code?: string;
  message?: string;
  exitCode?: number;
  traceSummaryPath?: string;
}

export type OpenCliCommandRunner = (
  executable: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

export interface OpenCliTransportDeps {
  runCommand?: OpenCliCommandRunner;
  acquireLock?: typeof acquireProfileRunLock;
  resolveSessionDir?: (sessionId: string) => Promise<string>;
  now?: () => Date;
  randomId?: () => string;
}

interface OpenCliContext {
  executable: string;
  version: string;
  runCommand: OpenCliCommandRunner;
}

interface AssistantMarker {
  index?: number;
  sha256: string;
}

interface OracleWaitRow {
  ContractVersion?: number;
  Status?: string;
  conversationId?: string;
  conversationUrl?: string;
  AssistantIndex?: number;
  AssistantSha256?: string;
  Markdown?: string;
  StableSeconds?: number;
}

interface PreparedSubmission {
  path: string;
  sha256: string;
  artifact: SessionArtifact;
  journalPath: string;
  adapterManifestPath: string;
}

const defaultCommandRunner: OpenCliCommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, {
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

export async function runOpenCliBrowserMode(
  options: BrowserRunOptions,
  deps: OpenCliTransportDeps = {},
): Promise<BrowserRunResult> {
  const startedAt = Date.now();
  const logger = options.log ?? (() => {});
  const config = options.config ?? {};
  logger(
    "[browser] OpenCLI window policy: background/no-focus (Chrome may remain visibly open behind other windows).",
  );
  assertSupportedRun(options);
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    throw blockedError(
      "OpenCLI browser transport requires an Oracle session id.",
      "session-missing",
    );
  }

  const operationRef = buildOperationRef(sessionId, deps.randomId?.() ?? randomUUID());
  const prepared = await prepareSubmission(
    sessionId,
    operationRef,
    options.prompt,
    options.attachments ?? [],
    deps,
  );
  const targetUrl = resolveTargetUrl(config);
  await appendJournal(prepared.journalPath, {
    event: "authorized",
    contractVersion: OPENCLI_CONTRACT_VERSION,
    operationRef,
    payloadSha256: prepared.sha256,
    target: targetUrl,
    windowMode: OPENCLI_WINDOW_MODE,
    at: (deps.now?.() ?? new Date()).toISOString(),
  });

  const context = await preflightOpenCli(config, deps);
  const lockDir = path.join(getOracleHomeDir(), "opencli-browser-bridge");
  const acquireLock = deps.acquireLock ?? acquireProfileRunLock;
  let lock: Awaited<ReturnType<typeof acquireProfileRunLock>> = null;
  let dispatchMayHaveOccurred = false;
  let conversationUrl: string | undefined;
  let conversationId: string | undefined;
  let modelSelection: BrowserModelSelectionEvidence | undefined;
  let baselineAssistant: AssistantMarker | undefined;
  let dispatchAt: string | undefined;
  let submitCommandStarted = false;
  const buildSubmittedRuntime = (): BrowserRuntimeMetadata => ({
    browserTransport: "opencli",
    tabUrl: conversationUrl,
    conversationId: conversationId ?? extractConversationId(conversationUrl),
    promptSubmitted: true,
    controllerPid: process.pid,
    opencliOperationRef: operationRef,
    opencliVersion: context.version,
    opencliPayloadSha256: prepared.sha256,
    opencliWindowMode: OPENCLI_WINDOW_MODE,
    opencliDispatchAt: dispatchAt,
    proDispatchAt: dispatchAt,
    opencliBaselineAssistantIndex: baselineAssistant?.index,
    opencliBaselineAssistantSha256: baselineAssistant?.sha256,
  });

  try {
    lock = await acquireLock(lockDir, {
      timeoutMs: config.profileLockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      sessionId,
      logger: (message) => logger(`[browser] ${message}`),
    });
    if (!lock) {
      throw blockedError(
        "OpenCLI transport lock is disabled; set a positive browser profile lock timeout.",
        "transport-busy",
      );
    }

    assertOpenCliModelStrategy(config);

    const currentPayloadHash = await computeFileSha256(prepared.path);
    if (currentPayloadHash !== prepared.sha256) {
      throw blockedError(
        "The sealed OpenCLI submission changed after authorization; nothing was submitted.",
        "bundle-integrity-failed",
      );
    }

    await options.runtimeHintCb?.(
      {
        browserTransport: "opencli",
        tabUrl: targetUrl.includes("/c/") ? targetUrl : undefined,
        conversationId: extractConversationId(targetUrl),
        promptSubmitted: false,
        controllerPid: process.pid,
        opencliOperationRef: operationRef,
        opencliVersion: context.version,
        opencliPayloadSha256: prepared.sha256,
        opencliWindowMode: OPENCLI_WINDOW_MODE,
        opencliBaselineAssistantIndex: baselineAssistant?.index,
        opencliBaselineAssistantSha256: baselineAssistant?.sha256,
      },
      undefined,
    );

    submitCommandStarted = true;
    const receipt = await submitAuthorizedFiles(
      context,
      prepared.adapterManifestPath,
      targetUrl,
      config,
    );
    conversationUrl = receipt.url;
    conversationId = receipt.conversationId;
    baselineAssistant = receipt.baselineAssistant;
    modelSelection = receipt.modelSelection;
    dispatchMayHaveOccurred = true;
    dispatchAt = await journalEventAt(prepared.journalPath, operationRef, "dispatch-intent").catch(
      () => undefined,
    );
    await appendJournal(prepared.journalPath, {
      event: "submitted",
      operationRef,
      conversationUrl,
      conversationId,
      baselineAssistantIndex: baselineAssistant?.index,
      baselineAssistantSha256: baselineAssistant?.sha256,
      at: (deps.now?.() ?? new Date()).toISOString(),
    });
    await options.runtimeHintCb?.(
      {
        browserTransport: "opencli",
        tabUrl: conversationUrl,
        conversationId,
        promptSubmitted: true,
        controllerPid: process.pid,
        opencliOperationRef: operationRef,
        opencliVersion: context.version,
        opencliPayloadSha256: prepared.sha256,
        opencliWindowMode: OPENCLI_WINDOW_MODE,
        opencliDispatchAt: dispatchAt,
        proDispatchAt: dispatchAt,
        opencliBaselineAssistantIndex: baselineAssistant?.index,
        opencliBaselineAssistantSha256: baselineAssistant?.sha256,
      },
      modelSelection,
    );
  } catch (error) {
    // A validated conversation receipt is the irreversible boundary. Local
    // journal/session persistence may fail after ChatGPT accepted the turn, but
    // that can never be reclassified as a pre-submit failure or a safe retry.
    if (conversationUrl) {
      const recoverableRuntime = buildSubmittedRuntime();
      await appendJournal(prepared.journalPath, {
        event: "post-submit-persistence-failed",
        operationRef,
        conversationUrl,
        conversationId: recoverableRuntime.conversationId,
        at: (deps.now?.() ?? new Date()).toISOString(),
      }).catch(() => undefined);
      throw new BrowserAutomationError(
        "ChatGPT accepted the Oracle turn and returned a valid conversation receipt, but Oracle could not finish local post-submit persistence. Resume this session to run the waiter only; do not resubmit the turn.",
        {
          stage: "post-submit-persistence",
          reason: "post-submit-persistence-failed",
          submitted: true,
          runtime: recoverableRuntime,
        },
        error,
      );
    }
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    if (submitCommandStarted && !conversationUrl) {
      dispatchMayHaveOccurred = await journalHasEvent(
        prepared.journalPath,
        operationRef,
        "dispatch-intent",
      ).catch(() => true);
    }
    if (dispatchMayHaveOccurred && !conversationUrl) {
      await appendJournal(prepared.journalPath, {
        event: "ambiguous",
        operationRef,
        at: (deps.now?.() ?? new Date()).toISOString(),
      }).catch(() => undefined);
      throw new BrowserAutomationError(
        "OpenCLI submission may have occurred, but no durable conversation receipt was captured. Oracle will not resubmit automatically.",
        {
          stage: "dispatch-ambiguous",
          runtime: {
            browserTransport: "opencli",
            promptSubmitted: true,
            controllerPid: process.pid,
            opencliOperationRef: operationRef,
            opencliVersion: context.version,
            opencliPayloadSha256: prepared.sha256,
            opencliWindowMode: OPENCLI_WINDOW_MODE,
            opencliDispatchAt: dispatchAt,
            proDispatchAt: dispatchAt,
            opencliBaselineAssistantIndex: baselineAssistant?.index,
            opencliBaselineAssistantSha256: baselineAssistant?.sha256,
          } satisfies BrowserRuntimeMetadata,
        },
        error,
      );
    }
    throw blockedError(
      "OpenCLI Browser Bridge failed before submission; retrying this Oracle turn is safe.",
      "opencli-blocked",
      error,
    );
  } finally {
    await lock?.release();
  }

  const runtime = buildSubmittedRuntime();
  if (!runtime.opencliDispatchAt) {
    throw new BrowserAutomationError(
      "OpenCLI returned a conversation receipt without the durable dispatch timestamp required for Pro response timing.",
      {
        stage: "response-timing",
        code: "dispatch-timestamp-missing",
        runtime,
      },
    );
  }

  try {
    const answer = await captureDetail(context, runtime, config);
    const capturedAt = deps.now?.() ?? new Date();
    const responseElapsedMs = elapsedSinceDispatch(runtime.opencliDispatchAt, capturedAt);
    const completedRuntime: BrowserRuntimeMetadata = {
      ...runtime,
      opencliResponseElapsedMs: responseElapsedMs,
      proResponseElapsedMs: responseElapsedMs,
    };
    await appendJournal(prepared.journalPath, {
      event: "answer-captured",
      operationRef,
      conversationUrl,
      assistantSha256: createHash("sha256").update(answer).digest("hex"),
      responseElapsedMs,
      at: capturedAt.toISOString(),
    });
    const timedRuntime = recordProResponseTiming(completedRuntime, capturedAt, {
      requireTimestamp: true,
    });
    await appendJournal(prepared.journalPath, {
      event: "complete",
      operationRef,
      conversationUrl,
      responseElapsedMs,
      at: capturedAt.toISOString(),
    });
    return {
      answerText: answer,
      answerMarkdown: answer,
      artifacts: [prepared.artifact],
      modelSelection,
      tookMs: Date.now() - startedAt,
      answerTokens: estimateTokenCount(answer),
      answerChars: answer.length,
      ...timedRuntime,
    };
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw new BrowserAutomationError(
      "ChatGPT accepted the Oracle turn, but OpenCLI could not harvest the completed answer. Resume this Oracle session to retry the waiter only.",
      { stage: "assistant-timeout", runtime },
      error,
    );
  }
}

export async function resumeOpenCliBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: OpenCliTransportDeps = {},
): Promise<{
  answerText: string;
  answerMarkdown: string;
  runtime: BrowserRuntimeMetadata;
}> {
  const context = await preflightOpenCli(config ?? {}, deps);
  const conversationUrl = runtime.tabUrl;
  if (!extractConversationId(conversationUrl)) {
    throw new BrowserAutomationError(
      "OpenCLI session has no recoverable ChatGPT conversation receipt; Oracle will not resubmit it.",
      { stage: "dispatch-ambiguous", runtime },
    );
  }
  const answer = await captureDetail(context, runtime, config ?? {});
  const capturedAt = deps.now?.() ?? new Date();
  const timedRuntime = verifyStoredProResponseWorkloadTiming({
    answer,
    runtime,
    capturedAt,
  });
  return { answerText: answer, answerMarkdown: answer, runtime: timedRuntime };
}

async function preflightOpenCli(
  config: BrowserSessionConfig,
  deps: OpenCliTransportDeps,
): Promise<OpenCliContext> {
  const executable = config.opencliPath?.trim() || "opencli";
  const runCommandImpl = deps.runCommand ?? defaultCommandRunner;
  let versionOutput: CommandResult;
  try {
    versionOutput = await runCommandImpl(executable, ["--version"], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    throw blockedError(
      "OpenCLI is unavailable; install or configure it before using the Browser Bridge transport.",
      "bridge-unavailable",
      error,
    );
  }
  const version = parseCompatibleVersion(versionOutput.stdout);
  const context = { executable, version, runCommand: runCommandImpl };
  try {
    await runCommand(context, ["daemon", "status"], COMMAND_TIMEOUT_MS, "daemon-status");
    const adapterHelp = await runCommand(
      context,
      ["chatgpt", "submit-file", "--help"],
      COMMAND_TIMEOUT_MS,
      "submit-file-adapter",
    );
    if (
      !/Arguments:\s*\n\s*manifest\b/u.test(adapterHelp.stdout) ||
      !/Oracle picker contract v3/u.test(adapterHelp.stdout) ||
      !/Output columns:\s*ContractVersion, Status, conversationId, conversationUrl, Model, ModelStatus, ModelLabel, ThinkingStatus, ThinkingLabel, Files, BaselineAssistantIndex, BaselineAssistantSha256/u.test(
        adapterHelp.stdout,
      )
    ) {
      throw new Error("The installed chatgpt submit-file adapter has an incompatible contract.");
    }
    const waiterHelp = await runCommand(
      context,
      ["chatgpt", "oracle-wait", "--help"],
      COMMAND_TIMEOUT_MS,
      "oracle-wait-adapter",
    );
    if (
      !/Arguments:\s*\n\s*id\b/u.test(waiterHelp.stdout) ||
      !/Output columns:\s*ContractVersion, Status, conversationId, conversationUrl, AssistantIndex, AssistantSha256, Markdown, StableSeconds/u.test(
        waiterHelp.stdout,
      )
    ) {
      throw new Error("The installed chatgpt oracle-wait adapter has an incompatible contract.");
    }
  } catch (error) {
    throw blockedError(
      "OpenCLI Browser Bridge or the Oracle companion adapters are unavailable. Run the Oracle adapter installer before submitting private content.",
      "bridge-unavailable",
      error,
    );
  }
  return context;
}

function assertOpenCliModelStrategy(config: BrowserSessionConfig): void {
  if (config.modelStrategy === "ignore" || config.modelStrategy === "current") {
    throw blockedError(
      "OpenCLI transport requires modelStrategy=select so every unattended turn verifies Pro before dispatch.",
      "model-unconfirmed",
    );
  }
}

async function submitAuthorizedFiles(
  context: OpenCliContext,
  adapterManifestPath: string,
  targetUrl: string,
  config: BrowserSessionConfig,
): Promise<{
  url: string;
  conversationId: string;
  baselineAssistant?: AssistantMarker;
  modelSelection: BrowserModelSelectionEvidence;
}> {
  const existingConversationId = extractConversationId(targetUrl);
  const targetArgs = existingConversationId ? ["--conversation", targetUrl] : ["--new", "true"];
  const adapterTimeoutMs =
    MODEL_TIMEOUT_MS +
    (config.attachmentTimeoutMs ?? DEFAULT_BROWSER_ATTACHMENT_TIMEOUT_MS) +
    COMMAND_TIMEOUT_MS;
  const adapterTimeoutSeconds = Math.ceil(adapterTimeoutMs / 1000);
  const rows = await runJsonCommand<
    Array<{
      ContractVersion?: number;
      Status?: string;
      conversationId?: string;
      conversationUrl?: string;
      Model?: string;
      ModelStatus?: string;
      ModelLabel?: string;
      ThinkingStatus?: string;
      ThinkingLabel?: string;
      BaselineAssistantIndex?: number;
      BaselineAssistantSha256?: string;
    }>
  >(
    context,
    [
      "chatgpt",
      "submit-file",
      adapterManifestPath,
      ...targetArgs,
      "--timeout",
      String(adapterTimeoutSeconds),
      "-f",
      "json",
      "--trace",
      "retain-on-failure",
      "--window",
      OPENCLI_WINDOW_MODE,
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "true",
    ],
    adapterTimeoutMs + COMMAND_TIMEOUT_MS,
    "submit-file",
  );
  const row = rows[0];
  const conversationId = row?.conversationId;
  const conversationUrl = row?.conversationUrl;
  if (
    row?.ContractVersion !== OPENCLI_CONTRACT_VERSION ||
    row?.Status !== "Submitted" ||
    row?.Model !== "GPT-5.6 Pro" ||
    !["already-selected", "switched"].includes(row.ModelStatus ?? "") ||
    !["already-selected", "switched"].includes(row.ThinkingStatus ?? "") ||
    !/5[._ -]?6\s+sol/iu.test(row.ModelLabel ?? "") ||
    !/\bpro\b/iu.test(row.ThinkingLabel ?? "") ||
    !conversationId ||
    !conversationUrl ||
    extractConversationId(conversationUrl) !== conversationId
  ) {
    throw new Error("OpenCLI submit-file returned an incompatible or incomplete receipt.");
  }
  const baselineAssistant =
    Number.isFinite(row.BaselineAssistantIndex) &&
    /^[a-f0-9]{64}$/u.test(row.BaselineAssistantSha256 ?? "")
      ? {
          index: row.BaselineAssistantIndex,
          sha256: row.BaselineAssistantSha256!,
        }
      : undefined;
  if (existingConversationId && !baselineAssistant) {
    throw new Error("OpenCLI submit-file did not return the required follow-up baseline receipt.");
  }
  const modelSelection: BrowserModelSelectionEvidence = {
    requestedModel: config.desiredModel ?? "GPT-5.6 Pro",
    resolvedLabel: row.Model,
    strategy: "select",
    status:
      row.ModelStatus === "already-selected" && row.ThinkingStatus === "already-selected"
        ? "already-selected"
        : "switched",
    verified: true,
    source: "chatgpt-model-picker",
    capturedAt: new Date().toISOString(),
  };
  return { url: conversationUrl, conversationId, baselineAssistant, modelSelection };
}

async function captureDetail(
  context: OpenCliContext,
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig,
): Promise<string> {
  const conversation = runtime.tabUrl ?? runtime.conversationId;
  if (!conversation) {
    throw new Error("Missing ChatGPT conversation receipt.");
  }
  const timeoutMs = config.timeoutMs ?? 1_200_000;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const baselineArgs = [
    ...(runtime.opencliBaselineAssistantIndex !== undefined
      ? ["--baseline-index", String(runtime.opencliBaselineAssistantIndex)]
      : []),
    ...(runtime.opencliBaselineAssistantSha256
      ? ["--baseline-sha256", runtime.opencliBaselineAssistantSha256]
      : []),
  ];
  const rows = await runJsonCommand<OracleWaitRow[]>(
    context,
    [
      "chatgpt",
      "oracle-wait",
      conversation,
      ...baselineArgs,
      "--timeout",
      String(timeoutSeconds),
      "--stable",
      String(ORACLE_WAIT_STABLE_SECONDS),
      "-f",
      "json",
      "--window",
      OPENCLI_WINDOW_MODE,
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "true",
    ],
    timeoutMs + COMMAND_TIMEOUT_MS,
    "oracle-wait",
  );
  const row = rows[0];
  const answer = row?.Markdown?.trim() ?? "";
  const conversationId = extractConversationId(row?.conversationUrl);
  const answerSha256 = answer ? createHash("sha256").update(answer).digest("hex") : "";
  if (
    row?.ContractVersion !== OPENCLI_CONTRACT_VERSION ||
    row?.Status !== "Complete" ||
    !answer ||
    !conversationId ||
    conversationId !== row.conversationId ||
    row.AssistantSha256 !== answerSha256 ||
    !Number.isFinite(row.AssistantIndex) ||
    (row.StableSeconds ?? -1) < ORACLE_WAIT_STABLE_SECONDS
  ) {
    throw new Error("OpenCLI oracle-wait returned an incompatible or incomplete result.");
  }
  return answer;
}

async function prepareSubmission(
  sessionId: string,
  operationRef: string,
  prompt: string,
  attachments: NonNullable<BrowserRunOptions["attachments"]>,
  deps: OpenCliTransportDeps,
): Promise<PreparedSubmission> {
  const resolveSessionDir =
    deps.resolveSessionDir ?? (async (id: string) => (await getSessionPaths(id)).dir);
  const sessionDir = await resolveSessionDir(sessionId);
  const artifactsDir = path.join(sessionDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(artifactsDir, 0o700);
  const filename = `oracle-submission-${operationRef}.md`;
  const submissionPath = path.join(artifactsDir, filename);
  const tempPath = `${submissionPath}.${process.pid}.tmp`;
  const contents = prompt.endsWith("\n") ? prompt : `${prompt}\n`;
  await fs.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(tempPath, submissionPath);
  await fs.chmod(submissionPath, 0o600);
  const sha256 = await computeFileSha256(submissionPath);
  const stat = await fs.stat(submissionPath);
  const journalPath = path.join(artifactsDir, `opencli-transport-${operationRef}.ndjson`);
  const adapterManifestPath = path.join(artifactsDir, `opencli-submit-${operationRef}.json`);
  const adapterManifestTemporaryPath = `${adapterManifestPath}.${process.pid}.tmp`;
  await fs.writeFile(
    adapterManifestTemporaryPath,
    `${JSON.stringify(
      {
        contractVersion: OPENCLI_CONTRACT_VERSION,
        payloadPath: submissionPath,
        payloadSha256: sha256,
        attachmentPaths: attachments.map((attachment) => attachment.path),
        operationRef,
        journalPath,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await fs.rename(adapterManifestTemporaryPath, adapterManifestPath);
  await fs.chmod(adapterManifestPath, 0o600);
  return {
    path: submissionPath,
    sha256,
    journalPath,
    adapterManifestPath,
    artifact: {
      kind: "file",
      path: submissionPath,
      label: "Sealed OpenCLI submission",
      mimeType: "text/markdown",
      sizeBytes: stat.size,
      sha256,
      validation: { type: "generic", ok: stat.size > 0 },
      transfer: { status: "completed", bytes: stat.size },
      origin: { mode: "local" },
    },
  };
}

async function appendJournal(journalPath: string, event: Record<string, unknown>): Promise<void> {
  const handle = await fs.open(journalPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    await fs.chmod(journalPath, 0o600);
  }
}

async function journalHasEvent(
  journalPath: string,
  operationRef: string,
  event: string,
): Promise<boolean> {
  const contents = await fs.readFile(journalPath, "utf8");
  return contents.split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      const record = JSON.parse(line) as { event?: unknown; operationRef?: unknown };
      return record.event === event && record.operationRef === operationRef;
    } catch {
      return false;
    }
  });
}

async function journalEventAt(
  journalPath: string,
  operationRef: string,
  event: string,
): Promise<string | undefined> {
  const contents = await fs.readFile(journalPath, "utf8");
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as {
        event?: unknown;
        operationRef?: unknown;
        at?: unknown;
      };
      if (
        record.event === event &&
        record.operationRef === operationRef &&
        typeof record.at === "string" &&
        Number.isFinite(Date.parse(record.at))
      ) {
        return record.at;
      }
    } catch {
      // A malformed non-authoritative line does not invalidate a later exact event.
    }
  }
  return undefined;
}

async function runJsonCommand<T>(
  context: OpenCliContext,
  args: string[],
  timeoutMs: number,
  stage: string,
): Promise<T> {
  const result = await runCommand(context, args, timeoutMs, stage);
  try {
    return JSON.parse(result.stdout.trim()) as T;
  } catch (error) {
    throw new Error(`OpenCLI returned an incompatible structured response for ${stage}.`, {
      cause: error,
    });
  }
}

async function runCommand(
  context: OpenCliContext,
  args: string[],
  timeoutMs: number,
  stage: string,
): Promise<CommandResult> {
  try {
    return await context.runCommand(context.executable, args, { timeoutMs });
  } catch (error) {
    throw new Error(`OpenCLI command failed during ${stage}.`, { cause: error });
  }
}

function parseCompatibleVersion(raw: string): string {
  const match = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    throw blockedError(
      "OpenCLI returned an unrecognized version; nothing was submitted.",
      "opencli-incompatible",
    );
  }
  const version = match.slice(1, 4).map((part) => Number.parseInt(part ?? "0", 10));
  const compatible =
    version[0] === 1 &&
    (version[1] > MIN_OPENCLI_VERSION[1] ||
      (version[1] === MIN_OPENCLI_VERSION[1] && version[2] >= MIN_OPENCLI_VERSION[2]));
  if (!compatible) {
    throw blockedError(
      `OpenCLI ${match[0]} is incompatible; version 1.8.6 or newer in the 1.x line is required.`,
      "opencli-incompatible",
    );
  }
  return match[0];
}

function resolveTargetUrl(config: BrowserSessionConfig): string {
  const raw =
    config.resumeConversationUrl ?? config.chatgptUrl ?? config.url ?? "https://chatgpt.com/new";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw blockedError("OpenCLI received an invalid ChatGPT target URL.", "target-invalid", error);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") {
    throw blockedError(
      "OpenCLI browser transport only dispatches to explicit https://chatgpt.com targets.",
      "target-invalid",
    );
  }
  if (!config.resumeConversationUrl && (parsed.pathname === "/" || parsed.pathname === "")) {
    parsed.pathname = "/new";
  }
  return parsed.toString();
}

function extractConversationId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return undefined;
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/u);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function buildOperationRef(sessionId: string, randomId: string): string {
  const safeSession = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const safeRandom = randomId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 12);
  return `oracle-${safeSession || "session"}-${safeRandom || "turn"}`;
}

function assertSupportedRun(options: BrowserRunOptions): void {
  if (options.generateImagePath) {
    throw blockedError(
      "OpenCLI transport currently supports Oracle GPT-5.6 Pro text consultations only, not image generation.",
      "unsupported-operation",
    );
  }
  if (options.config?.researchMode === "deep") {
    throw blockedError(
      "OpenCLI transport currently supports Oracle GPT-5.6 Pro text consultations only, not Deep Research.",
      "unsupported-operation",
    );
  }
  if ((options.followUpPrompts?.length ?? 0) > 0) {
    throw blockedError(
      "Submit OpenCLI follow-ups as Oracle session follow-ups so each turn receives its own sealed artifact and recovery receipt.",
      "unsupported-operation",
    );
  }
}

function blockedError(message: string, reason: string, cause?: unknown): BrowserAutomationError {
  const opencliFailure = summarizeOpenCliFailure(cause);
  return new BrowserAutomationError(
    message,
    {
      stage: "opencli-blocked",
      reason,
      submitted: false,
      ...(opencliFailure ? { opencliFailure } : {}),
    },
    cause,
  );
}

function summarizeOpenCliFailure(error: unknown): OpenCliFailureEvidence | undefined {
  let current = error;
  let fallbackMessage: string | undefined;
  const evidence: OpenCliFailureEvidence = {};

  for (let depth = 0; current && depth < 6; depth += 1) {
    if (!(current instanceof Error) && typeof current !== "object") break;
    const candidate = current as Error & {
      cause?: unknown;
      code?: unknown;
      stderr?: unknown;
    };
    const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
    const stageMatch = message.match(/^OpenCLI command failed during ([^.]+)\.$/u);
    if (stageMatch?.[1]) evidence.stage = stageMatch[1];
    else if (message && !fallbackMessage) fallbackMessage = message;

    if (typeof candidate.code === "number") evidence.exitCode = candidate.code;
    else if (typeof candidate.code === "string" && /^\d+$/u.test(candidate.code)) {
      evidence.exitCode = Number.parseInt(candidate.code, 10);
    }

    if (typeof candidate.stderr === "string") {
      const stderr = candidate.stderr;
      const codeMatch = stderr.match(/^\s*code:\s*([A-Z][A-Z0-9_]*)\s*$/mu);
      const messageMatch = stderr.match(/^\s*message:\s*(.+?)\s*$/mu);
      const traceMatch = stderr.match(/^\s*summaryPath:\s*(.+?)\s*$/mu);
      if (codeMatch?.[1]) evidence.code = codeMatch[1];
      if (messageMatch?.[1]) evidence.message = messageMatch[1].replace(/^['"]|['"]$/gu, "");
      if (traceMatch?.[1]) {
        evidence.traceSummaryPath = traceMatch[1].replace(/^['"]|['"]$/gu, "");
      }
    }
    current = candidate.cause;
  }

  if (!evidence.stage && !evidence.code && !evidence.traceSummaryPath) return undefined;
  if (!evidence.message && fallbackMessage) evidence.message = fallbackMessage;
  return evidence;
}

export const __test__ = {
  buildOperationRef,
  extractConversationId,
  parseCompatibleVersion,
  resolveTargetUrl,
};
