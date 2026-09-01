import { OracleClient } from "../../packages/oracle-client/src/index.js";
import {
  admitBrokerReview,
  prepareBrokerReview,
  resolveBrokerPaths,
  waitForBrokerJob,
  type BrokerPaths,
} from "../v2/broker.js";

export interface BrokerMcpConsultInput {
  prompt: string;
  files?: string[];
  maxFileSizeBytes?: number;
  idempotencyKey?: string;
  waitTimeoutMs?: number;
  dryRun?: boolean;
  cwd?: string;
  paths?: BrokerPaths;
  sendLog?: (message: string) => void | Promise<void>;
}

export async function runBrokerMcpConsult(input: BrokerMcpConsultInput): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    jobId?: string;
    status: string;
    state?: string;
    output: string;
    dryRun?: boolean;
    timedOut?: boolean;
  };
}> {
  const textContent = (text: string) => [{ type: "text" as const, text }];
  if (input.dryRun) {
    const prepared = await prepareBrokerReview(input);
    const output = JSON.stringify(
      {
        engine: "broker",
        route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
        promptBytes: prepared.promptBytes.byteLength,
        bundleSha256: prepared.bundleSha256 ?? null,
        bundleFilename: prepared.bundleFilename ?? null,
        files: prepared.files,
        dispatch: false,
      },
      null,
      2,
    );
    return {
      content: textContent(output),
      structuredContent: { status: "dry-run", output, dryRun: true },
    };
  }

  if (!input.idempotencyKey?.trim()) {
    const output = "Oracle broker live admission requires an idempotencyKey";
    return {
      isError: true,
      content: textContent(output),
      structuredContent: { status: "error", output },
    };
  }

  const paths = input.paths ?? resolveBrokerPaths();
  const client = new OracleClient({ socketPath: paths.socketPath });
  let jobId: string | undefined;
  let state: string | undefined;
  try {
    const admission = await admitBrokerReview({
      prompt: input.prompt,
      files: input.files,
      maxFileSizeBytes: input.maxFileSizeBytes,
      cwd: input.cwd,
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: "oracle-mcp",
      paths,
      client,
    });
    jobId = admission.admission.job.id;
    state = admission.admission.job.state.kind;
    await input.sendLog?.(
      `${admission.admission.created ? "Admitted" : "Reattached to"} Oracle v2 job ${jobId}.`,
    );
    const settled = await waitForBrokerJob(client, jobId, {
      timeoutMs: input.waitTimeoutMs ?? 120_000,
      onEvent: (event) => input.sendLog?.(`Oracle v2: ${event.type}`),
    });
    state = settled.job.state.kind;
    if (settled.timedOut) {
      const output = `Oracle v2 job ${jobId} is still ${settled.job.state.kind}; the worker continues independently.`;
      return {
        content: textContent(output),
        structuredContent: {
          jobId,
          status: "running",
          state: settled.job.state.kind,
          output: "",
          timedOut: true,
        },
      };
    }
    if (!settled.result?.ready) {
      const output = `Oracle v2 job ${jobId} stopped in state ${settled.job.state.kind}.`;
      return {
        isError: true,
        content: textContent(output),
        structuredContent: {
          jobId,
          status: "failed",
          state: settled.job.state.kind,
          output,
        },
      };
    }
    return {
      content: textContent(settled.result.text),
      structuredContent: {
        jobId,
        status: "completed",
        state: "completed",
        output: settled.result.text,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = jobId
      ? `Oracle v2 job ${jobId} remains durable, but client observation failed: ${detail}`
      : detail;
    return {
      isError: true,
      content: textContent(output),
      structuredContent: {
        ...(jobId ? { jobId } : {}),
        status: jobId ? "observation-error" : "admission-error",
        ...(state ? { state } : {}),
        output,
      },
    };
  } finally {
    client.close();
  }
}
