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
import { acquireProfileRunLock } from "./profileState.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "./types.js";
import { delay, estimateTokenCount } from "./utils.js";

const execFileAsync = promisify(execFile);
const OPENCLI_CONTRACT_VERSION = 1;
const MIN_OPENCLI_VERSION = [1, 8, 3] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 120_000;

interface CommandResult {
  stdout: string;
  stderr: string;
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
  sleep?: (ms: number) => Promise<void>;
}

interface OpenCliContext {
  executable: string;
  version: string;
  runCommand: OpenCliCommandRunner;
}

interface DetailRow {
  Index?: number;
  Role?: string;
  Text?: string;
  Generating?: boolean;
  StableSeconds?: number;
}

interface AssistantMarker {
  answer: string;
  index?: number;
  sha256: string;
}

interface ModelRow {
  Status?: string;
  Model?: string;
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

    modelSelection = await ensureProModel(context, config);
    await appendJournal(prepared.journalPath, {
      event: "model-ready",
      operationRef,
      reportedModel: modelSelection.resolvedLabel,
      at: (deps.now?.() ?? new Date()).toISOString(),
    });

    const currentPayloadHash = await computeFileSha256(prepared.path);
    if (currentPayloadHash !== prepared.sha256) {
      throw blockedError(
        "The sealed OpenCLI submission changed after authorization; nothing was submitted.",
        "bundle-integrity-failed",
      );
    }

    if (extractConversationId(targetUrl)) {
      baselineAssistant = await readLatestAssistantMarker(context, targetUrl);
      if (!baselineAssistant) {
        throw blockedError(
          "OpenCLI could not establish the prior assistant-turn marker for this follow-up; nothing was submitted.",
          "followup-baseline-missing",
        );
      }
    }

    await appendJournal(prepared.journalPath, {
      event: "dispatch-intent",
      operationRef,
      payloadSha256: prepared.sha256,
      target: targetUrl,
      attempt: 1,
      baselineAssistantIndex: baselineAssistant?.index,
      baselineAssistantSha256: baselineAssistant?.sha256,
      at: (deps.now?.() ?? new Date()).toISOString(),
    });
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
        opencliBaselineAssistantIndex: baselineAssistant?.index,
        opencliBaselineAssistantSha256: baselineAssistant?.sha256,
      },
      modelSelection,
    );

    dispatchMayHaveOccurred = true;
    const receipt = await submitAuthorizedFiles(
      context,
      prepared.adapterManifestPath,
      targetUrl,
      config,
    );
    conversationUrl = receipt.url;
    conversationId = receipt.conversationId;
    await appendJournal(prepared.journalPath, {
      event: "submitted",
      operationRef,
      conversationUrl,
      conversationId,
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
        opencliBaselineAssistantIndex: baselineAssistant?.index,
        opencliBaselineAssistantSha256: baselineAssistant?.sha256,
      },
      modelSelection,
    );
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
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

  const runtime: BrowserRuntimeMetadata = {
    browserTransport: "opencli",
    tabUrl: conversationUrl,
    conversationId,
    promptSubmitted: true,
    controllerPid: process.pid,
    opencliOperationRef: operationRef,
    opencliVersion: context.version,
    opencliPayloadSha256: prepared.sha256,
    opencliBaselineAssistantIndex: baselineAssistant?.index,
    opencliBaselineAssistantSha256: baselineAssistant?.sha256,
  };

  try {
    const answer = await captureDetail(context, runtime, config, deps);
    await appendJournal(prepared.journalPath, {
      event: "complete",
      operationRef,
      conversationUrl,
      at: (deps.now?.() ?? new Date()).toISOString(),
    });
    return {
      answerText: answer,
      answerMarkdown: answer,
      artifacts: [prepared.artifact],
      modelSelection,
      tookMs: Date.now() - startedAt,
      answerTokens: estimateTokenCount(answer),
      answerChars: answer.length,
      ...runtime,
    };
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw new BrowserAutomationError(
      "ChatGPT accepted the Oracle turn, but OpenCLI could not harvest the completed answer. Resume this Oracle session to retry detail only.",
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
): Promise<{ answerText: string; answerMarkdown: string }> {
  const context = await preflightOpenCli(config ?? {}, deps);
  const conversationUrl = runtime.tabUrl;
  if (!extractConversationId(conversationUrl)) {
    throw new BrowserAutomationError(
      "OpenCLI session has no recoverable ChatGPT conversation receipt; Oracle will not resubmit it.",
      { stage: "dispatch-ambiguous", runtime },
    );
  }
  const answer = await captureDetail(context, runtime, config ?? {}, deps);
  return { answerText: answer, answerMarkdown: answer };
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
    await runCommand(context, ["doctor"], COMMAND_TIMEOUT_MS, "doctor");
    const adapterHelp = await runCommand(
      context,
      ["chatgpt", "submit-file", "--help"],
      COMMAND_TIMEOUT_MS,
      "submit-file-adapter",
    );
    if (
      !/Arguments:\s*\n\s*manifest\b/u.test(adapterHelp.stdout) ||
      !/Output columns:\s*ContractVersion, Status, conversationId, conversationUrl, Model, Files/u.test(
        adapterHelp.stdout,
      )
    ) {
      throw new Error("The installed chatgpt submit-file adapter has an incompatible contract.");
    }
  } catch (error) {
    throw blockedError(
      "OpenCLI Browser Bridge or the Oracle submit-file adapter is unavailable. Run the Oracle adapter installer before submitting private content.",
      "bridge-unavailable",
      error,
    );
  }
  return context;
}

async function ensureProModel(
  context: OpenCliContext,
  config: BrowserSessionConfig,
): Promise<BrowserModelSelectionEvidence> {
  if (config.modelStrategy === "ignore" || config.modelStrategy === "current") {
    throw blockedError(
      "OpenCLI transport requires modelStrategy=select so every unattended turn verifies Pro before dispatch.",
      "model-unconfirmed",
    );
  }
  const rows = await runJsonCommand<ModelRow[]>(
    context,
    [
      "chatgpt",
      "model",
      "pro",
      "-f",
      "json",
      "--window",
      "background",
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "false",
    ],
    MODEL_TIMEOUT_MS,
    "model-pro",
  );
  const row = rows[0];
  if (!row || row.Model?.trim().toLowerCase() !== "pro") {
    throw blockedError(
      "OpenCLI did not return a structured Pro model receipt; nothing was submitted.",
      "model-unconfirmed",
    );
  }
  const alreadySelected = /already/i.test(row.Status ?? "");
  return {
    requestedModel: config.desiredModel ?? "Pro",
    resolvedLabel: "Pro",
    strategy: "select",
    status: alreadySelected ? "already-selected" : "switched",
    verified: true,
    source: "chatgpt-model-picker",
    capturedAt: new Date().toISOString(),
  };
}

async function submitAuthorizedFiles(
  context: OpenCliContext,
  adapterManifestPath: string,
  targetUrl: string,
  config: BrowserSessionConfig,
): Promise<{ url: string; conversationId: string }> {
  const existingConversationId = extractConversationId(targetUrl);
  const targetArgs = existingConversationId ? ["--conversation", targetUrl] : ["--new", "true"];
  const rows = await runJsonCommand<
    Array<{
      ContractVersion?: number;
      Status?: string;
      conversationId?: string;
      conversationUrl?: string;
      Model?: string;
    }>
  >(
    context,
    [
      "chatgpt",
      "submit-file",
      adapterManifestPath,
      ...targetArgs,
      "-f",
      "json",
      "--window",
      "background",
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "false",
    ],
    (config.attachmentTimeoutMs ?? MODEL_TIMEOUT_MS) + COMMAND_TIMEOUT_MS,
    "submit-file",
  );
  const row = rows[0];
  const conversationId = row?.conversationId;
  const conversationUrl = row?.conversationUrl;
  if (
    row?.ContractVersion !== OPENCLI_CONTRACT_VERSION ||
    row?.Status !== "Submitted" ||
    row?.Model !== "Pro" ||
    !conversationId ||
    !conversationUrl ||
    extractConversationId(conversationUrl) !== conversationId
  ) {
    throw new Error("OpenCLI submit-file returned an incompatible or incomplete receipt.");
  }
  return { url: conversationUrl, conversationId };
}

async function captureDetail(
  context: OpenCliContext,
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig,
  deps: OpenCliTransportDeps,
): Promise<string> {
  const conversation = runtime.tabUrl ?? runtime.conversationId;
  if (!conversation) {
    throw new Error("Missing ChatGPT conversation receipt.");
  }
  const timeoutMs = config.timeoutMs ?? 1_200_000;
  const deadline = Date.now() + timeoutMs;
  const sleep = deps.sleep ?? delay;
  let lastAnswer = "";
  let stablePolls = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const latest = latestAssistantMarker(await readDetail(context, conversation));
      if (latest && !matchesBaselineAssistant(latest, runtime)) {
        const answer = latest.answer;
        stablePolls = answer === lastAnswer ? stablePolls + 1 : 1;
        lastAnswer = answer;
        if (stablePolls >= 2) return answer;
      } else {
        stablePolls = 0;
        lastAnswer = "";
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
  }
  throw lastError ?? new Error("OpenCLI detail did not return a stable assistant response.");
}

async function readLatestAssistantMarker(
  context: OpenCliContext,
  conversation: string,
): Promise<AssistantMarker | undefined> {
  return latestAssistantMarker(await readDetail(context, conversation));
}

async function readDetail(context: OpenCliContext, conversation: string): Promise<DetailRow[]> {
  return runJsonCommand<DetailRow[]>(
    context,
    [
      "chatgpt",
      "detail",
      conversation,
      "--markdown",
      "true",
      "--wait",
      "false",
      "-f",
      "json",
      "--window",
      "background",
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "false",
    ],
    COMMAND_TIMEOUT_MS,
    "detail",
  );
}

function latestAssistantMarker(rows: DetailRow[]): AssistantMarker | undefined {
  let latest: DetailRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      row?.Role?.trim().toLowerCase() === "assistant" &&
      typeof row.Text === "string" &&
      row.Generating !== true
    ) {
      latest = row;
      break;
    }
  }
  const answer = latest?.Text?.trim() ?? "";
  if (!answer) return undefined;
  return {
    answer,
    index: Number.isFinite(latest?.Index) ? latest?.Index : undefined,
    sha256: createHash("sha256").update(answer).digest("hex"),
  };
}

function matchesBaselineAssistant(
  latest: AssistantMarker,
  runtime: BrowserRuntimeMetadata,
): boolean {
  const baselineSha256 = runtime.opencliBaselineAssistantSha256;
  if (!baselineSha256 || latest.sha256 !== baselineSha256) return false;
  const baselineIndex = runtime.opencliBaselineAssistantIndex;
  return (
    baselineIndex === undefined || latest.index === undefined || latest.index === baselineIndex
  );
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
      `OpenCLI ${match[0]} is incompatible; version 1.8.3 or newer in the 1.x line is required.`,
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
      "OpenCLI transport currently supports Oracle Pro text consultations only, not image generation.",
      "unsupported-operation",
    );
  }
  if (options.config?.researchMode === "deep") {
    throw blockedError(
      "OpenCLI transport currently supports Oracle Pro text consultations only, not Deep Research.",
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
  return new BrowserAutomationError(
    message,
    { stage: "opencli-blocked", reason, submitted: false },
    cause,
  );
}

export const __test__ = {
  buildOperationRef,
  extractConversationId,
  parseCompatibleVersion,
  resolveTargetUrl,
};
