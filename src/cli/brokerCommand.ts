import { OracleClient, type ClientEvent } from "../../packages/oracle-client/src/index.js";
import type { PreviewMode } from "../oracle/types.js";
import {
  admitBrokerReview,
  prepareBrokerReview,
  resolveBrokerPaths,
  waitForBrokerJob,
  writeBrokerOutput,
  type BrokerPaths,
} from "../v2/broker.js";

export interface BrokerCliCommandInput {
  prompt: string;
  files?: string[];
  system?: string;
  maxFileSizeBytes?: number;
  cwd?: string;
  requestId?: string;
  idempotencyKey?: string;
  wait: boolean;
  timeoutMs: number;
  previewMode?: PreviewMode;
  writeOutputPath?: string;
  paths?: BrokerPaths;
  log?: (message: string) => void;
}

export class BrokerCliJobError extends Error {
  readonly jobId: string;
  readonly phase: "observation" | "output-write";

  constructor(jobId: string, phase: "observation" | "output-write", cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Oracle v2 job ${jobId} was admitted, but client ${phase} failed: ${detail}`, {
      cause,
    });
    this.name = "BrokerCliJobError";
    this.jobId = jobId;
    this.phase = phase;
  }
}

export async function runBrokerCliCommand(input: BrokerCliCommandInput): Promise<{
  jobId?: string;
  state?: string;
  timedOut?: boolean;
  answer?: string;
}> {
  const log = input.log ?? console.log;
  if (input.previewMode) {
    const prepared = await prepareBrokerReview(input);
    const preview = {
      engine: "broker",
      route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
      prompt: prepared.promptText,
      promptBytes: prepared.promptBytes.byteLength,
      bundle: prepared.bundleSha256
        ? {
            sha256: prepared.bundleSha256,
            filename: prepared.bundleFilename,
            files: prepared.files,
          }
        : null,
      selectedFiles: prepared.selectedFiles,
      dispatch: false,
    };
    if (input.previewMode === "json") {
      log(JSON.stringify(preview, null, 2));
    } else if (input.previewMode === "full") {
      log(prepared.promptText.trimEnd());
      if (prepared.bundleBytes) log(`\n${prepared.bundleBytes.toString("utf8").trimEnd()}`);
    } else {
      log(
        `Oracle broker dry run — GPT-5.6 Sol / Pro, ${prepared.files.length} file${prepared.files.length === 1 ? "" : "s"}, ${prepared.bundleSha256 ? `bundle ${prepared.bundleSha256.slice(0, 12)}` : "text-only"}.`,
      );
    }
    return {};
  }

  const paths = input.paths ?? resolveBrokerPaths();
  const client = new OracleClient({ socketPath: paths.socketPath });
  let jobId: string | undefined;
  let phase: BrokerCliJobError["phase"] = "observation";
  try {
    const admitted = await admitBrokerReview({
      ...input,
      paths,
      client,
      idempotencyScope: "oracle-cli",
    });
    jobId = admitted.admission.job.id;
    log(
      `${admitted.admission.created ? "Admitted" : "Reattached to"} Oracle v2 job ${jobId} (${admitted.admission.job.state.kind}).`,
    );
    if (!input.wait) {
      log(`Inspect with: oracle job ${jobId}`);
      return { jobId, state: admitted.admission.job.state.kind };
    }
    const renderedEventTypes = new Set<string>();
    const settled = await waitForBrokerJob(client, jobId, {
      timeoutMs: input.timeoutMs,
      onEvent: (event) => renderBrokerEvent(event, renderedEventTypes, log),
    });
    if (settled.timedOut) {
      log(
        `Oracle v2 job ${jobId} is still ${settled.job.state.kind}; the worker continues independently. Inspect with: oracle job ${jobId}`,
      );
      return { jobId, state: settled.job.state.kind, timedOut: true };
    }
    if (settled.job.state.kind === "recoverable") {
      throw new Error(
        `Oracle v2 job ${jobId} requires explicit capture recovery; run oracle resume ${jobId} or inspect it with oracle job ${jobId}`,
      );
    }
    if (!settled.result?.ready) {
      throw new Error(`Oracle v2 job ${jobId} stopped in state ${settled.job.state.kind}`);
    }
    const answer = settled.result.text;
    log(answer);
    if (input.writeOutputPath) {
      phase = "output-write";
      const outputPath = await writeBrokerOutput(input.writeOutputPath, answer);
      log(`Saved assistant output to ${outputPath}`);
    }
    return { jobId, state: "completed", answer };
  } catch (error) {
    if (jobId) throw new BrokerCliJobError(jobId, phase, error);
    throw error;
  } finally {
    client.close();
  }
}

function renderBrokerEvent(
  event: ClientEvent,
  renderedTypes: Set<string>,
  log: (message: string) => void,
): void {
  if (event.type === "job-admitted" || renderedTypes.has(event.type)) return;
  renderedTypes.add(event.type);
  log(`Oracle v2: ${event.type}`);
}
