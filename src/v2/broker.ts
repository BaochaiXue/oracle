import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSealedSourceBundle,
  type SealedBundleFileReceipt,
} from "../../packages/oracle-bundle/src/index.js";
import {
  admitOracleJob,
  OracleClient,
  type ClientEvent,
  type ClientJob,
  type ClientJobResult,
  type OracleJobAdmission,
} from "../../packages/oracle-client/src/index.js";
import type { JobStateKind } from "../../packages/oracle-kernel/src/index.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { readFiles } from "../oracle/files.js";

const TERMINAL_JOB_STATES = new Set<JobStateKind>([
  "completed",
  "failed-unsent",
  "canceled-unsent",
  "abandoned",
  "ambiguous",
]);

export interface BrokerPaths {
  rootDir: string;
  socketPath: string;
  intentDirectory: string;
}

export interface PreparedBrokerReview {
  promptBytes: Buffer;
  promptText: string;
  bundleBytes?: Buffer;
  bundleSha256?: string;
  bundleFilename?: string;
  files: SealedBundleFileReceipt[];
  selectedFiles: string[];
}

export interface AdmitBrokerReviewInput {
  prompt: string;
  files?: string[];
  system?: string;
  maxFileSizeBytes?: number;
  cwd?: string;
  requestId?: string;
  idempotencyKey?: string;
  idempotencyScope?: string;
  maxCaptureMs?: number;
  paths?: BrokerPaths;
  client?: OracleClient;
}

export interface BrokerAdmission extends OracleJobAdmission {
  prepared: PreparedBrokerReview;
  requestId: string;
  idempotencyKey: string;
}

export interface BrokerWaitResult {
  job: ClientJob;
  timedOut: boolean;
  result?: ClientJobResult;
  lastEventSeq: number;
}

type BrokerWaitClient = Pick<OracleClient, "getJob" | "getResult" | "listEvents">;

export function resolveBrokerPaths(
  options: {
    oracleHomeDir?: string;
    socketPath?: string;
  } = {},
): BrokerPaths {
  const rootDir = path.join(options.oracleHomeDir ?? getOracleHomeDir(), "v2");
  return {
    rootDir,
    socketPath:
      options.socketPath ??
      process.env.ORACLE_V2_SOCKET_PATH?.trim() ??
      path.join(rootDir, "run", "oracle.sock"),
    intentDirectory: path.join(rootDir, "intents"),
  };
}

export async function prepareBrokerReview(input: {
  prompt: string;
  files?: string[];
  system?: string;
  maxFileSizeBytes?: number;
  cwd?: string;
}): Promise<PreparedBrokerReview> {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const userPrompt = input.prompt.trim();
  if (!userPrompt) throw new Error("Oracle broker prompt is required");
  const selected = await readFiles(input.files ?? [], {
    cwd,
    maxFileSizeBytes: input.maxFileSizeBytes,
  });
  const bundle =
    selected.length > 0 ? createSealedSourceBundle(createBundleInputs(selected, cwd)) : undefined;
  const promptSections = [input.system?.trim(), userPrompt].filter((section): section is string =>
    Boolean(section),
  );
  if (bundle) {
    promptSections.push(`Oracle source bundle SHA-256: ${bundle.artifactSha256}`);
  }
  const promptText = `${promptSections.join("\n\n").trimEnd()}\n`;
  return {
    promptBytes: Buffer.from(promptText, "utf8"),
    promptText,
    ...(bundle
      ? {
          bundleBytes: bundle.bytes,
          bundleSha256: bundle.artifactSha256,
          bundleFilename: bundle.filename,
          files: bundle.files,
        }
      : { files: [] }),
    selectedFiles: selected.map((file) => path.resolve(file.path)),
  };
}

export async function admitBrokerReview(input: AdmitBrokerReviewInput): Promise<BrokerAdmission> {
  const paths = input.paths ?? resolveBrokerPaths();
  const scope = input.idempotencyScope?.trim() || "oracle-cli";
  if (!input.requestId?.trim() && !input.idempotencyKey?.trim()) {
    throw new Error("Oracle broker live admission requires a stable idempotency key or request ID");
  }
  const identity = resolveBrokerIdentity({
    scope,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
  });
  const prepared = await prepareBrokerReview(input);
  const ownsClient = input.client === undefined;
  const client = input.client ?? new OracleClient({ socketPath: paths.socketPath });
  try {
    const admitted = await admitOracleJob(client, {
      requestId: identity.requestId,
      idempotency: { scope, key: identity.idempotencyKey },
      owner: { kind: "ordinary", sessionSlug: identity.requestId },
      promptBytes: prepared.promptBytes,
      bundleBytes: prepared.bundleBytes,
      intentDirectory: paths.intentDirectory,
      maxCaptureMs: input.maxCaptureMs,
    });
    return { ...admitted, prepared, ...identity };
  } finally {
    if (ownsClient) client.close();
  }
}

export async function waitForBrokerJob(
  client: BrokerWaitClient,
  jobId: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    afterEventSeq?: number;
    onEvent?: (event: ClientEvent) => void | Promise<void>;
  },
): Promise<BrokerWaitResult> {
  const deadline = Date.now() + options.timeoutMs;
  let lastEventSeq = options.afterEventSeq ?? 0;
  while (true) {
    const events = await client.listEvents(jobId, { after: lastEventSeq });
    for (const event of events) {
      lastEventSeq = Math.max(lastEventSeq, event.seq);
      await options.onEvent?.(event);
    }
    const job = await client.getJob(jobId);
    if (TERMINAL_JOB_STATES.has(job.state.kind)) {
      const finalEvents = await client.listEvents(jobId, { after: lastEventSeq });
      for (const event of finalEvents) {
        lastEventSeq = Math.max(lastEventSeq, event.seq);
        await options.onEvent?.(event);
      }
      return {
        job,
        timedOut: false,
        result: await client.getResult(jobId),
        lastEventSeq,
      };
    }
    if (Date.now() >= deadline) {
      return { job, timedOut: true, lastEventSeq };
    }
    await delay(options.pollMs ?? 250);
  }
}

export async function writeBrokerOutput(targetPath: string, content: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const directory = path.dirname(resolved);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content.endsWith("\n") ? content : `${content}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, resolved);
    await fs.chmod(resolved, 0o600);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return resolved;
}

function resolveBrokerIdentity(input: {
  scope: string;
  requestId?: string;
  idempotencyKey?: string;
}): { requestId: string; idempotencyKey: string } {
  const explicitRequestId = input.requestId?.trim();
  const explicitKey = input.idempotencyKey?.trim();
  if (explicitRequestId) {
    return { requestId: explicitRequestId, idempotencyKey: explicitKey || explicitRequestId };
  }
  if (explicitKey) {
    return {
      requestId: `broker-${digest(Buffer.from(`${input.scope}\0${explicitKey}`, "utf8")).slice(0, 24)}`,
      idempotencyKey: explicitKey,
    };
  }
  throw new Error("Oracle broker live admission requires a stable idempotency key or request ID");
}

function createBundleInputs(
  files: Array<{ path: string; content: string }>,
  cwd: string,
): Array<{ path: string; bytes: Buffer }> {
  const used = new Set<string>();
  const inputs: Array<{ path: string; bytes: Buffer }> = [];
  const externalOccurrences = new Map<string, number>();
  for (const file of files) {
    const bytes = Buffer.from(file.content, "utf8");
    const relative = path.relative(cwd, file.path).replaceAll(path.sep, "/");
    let bundlePath: string;
    if (
      relative &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative) &&
      !path.win32.isAbsolute(relative)
    ) {
      bundlePath = relative;
    } else {
      const contentIdentity = digest(bytes);
      let occurrence = (externalOccurrences.get(contentIdentity) ?? 0) + 1;
      externalOccurrences.set(contentIdentity, occurrence);
      bundlePath = `.oracle-v2-external/${contentIdentity}-${occurrence}`;
      while (used.has(bundlePath)) {
        occurrence += 1;
        externalOccurrences.set(contentIdentity, occurrence);
        bundlePath = `.oracle-v2-external/${contentIdentity}-${occurrence}`;
      }
    }
    used.add(bundlePath);
    inputs.push({ path: bundlePath, bytes });
  }
  return inputs;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
