import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test as vitestTest } from "vitest";
import { FakeProvider, OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import { JOB_SCHEMA_VERSION, type JobSpec } from "../../packages/oracle-kernel/src/index.js";
import { runBrokerMcpConsult } from "../../src/mcp/brokerConsult.js";
import {
  runJobEventsTool,
  runJobResultTool,
  runJobResumeTool,
  runJobStatusTool,
} from "../../src/mcp/tools/jobs.js";

const roots: string[] = [];
const test = process.platform === "win32" ? vitestTest.skip : vitestTest;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workerPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-mcp-broker-"));
  roots.push(root);
  return {
    rootDir: path.join(root, "store"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
    intentDirectory: path.join(root, "intents"),
  };
}

describe("Oracle v2 MCP broker", () => {
  vitestTest("fails closed before live admission when idempotencyKey is absent", async () => {
    const paths = workerPaths();
    const result = await runBrokerMcpConsult({
      prompt: "This must not be admitted without a stable key.",
      paths,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      output: expect.stringContaining("idempotencyKey"),
    });
  });

  test("returns a job handle on host timeout and reconnects with the same key without resending", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider({ captureDelayMs: 1_000 });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const request = {
      prompt: "Complete after the first MCP host budget expires.",
      idempotencyKey: "mcp-timeout-reconnect",
      paths,
    };

    const timedOut = await runBrokerMcpConsult({ ...request, waitTimeoutMs: 1 });
    expect(timedOut.isError).toBeUndefined();
    expect(timedOut.structuredContent).toMatchObject({
      jobId: expect.stringMatching(/^job_/u),
      status: "running",
      timedOut: true,
    });

    const completed = await runBrokerMcpConsult({ ...request, waitTimeoutMs: 5_000 });
    expect(completed.structuredContent).toMatchObject({
      jobId: timedOut.structuredContent.jobId,
      status: "completed",
      state: "completed",
    });
    expect(provider.sendCount(completed.structuredContent.jobId!)).toBe(1);
    await worker.stop();
  });

  test("returns recovery-required immediately when committed capture needs an explicit resume", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider({ captureFailures: 1 });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();

    const result = await runBrokerMcpConsult({
      prompt: "Surface capture recovery without waiting for the host timeout.",
      idempotencyKey: "mcp-recovery-required",
      waitTimeoutMs: 30_000,
      paths,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      jobId: expect.stringMatching(/^job_/u),
      status: "recovery-required",
      state: "recoverable",
      output: expect.stringContaining("job resume tool"),
    });
    expect(result.structuredContent).not.toHaveProperty("timedOut");
    expect(provider.sendCount(result.structuredContent.jobId!)).toBe(1);
    await worker.stop();
  });

  test("retains the admitted job handle when MCP observation fails", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const result = await runBrokerMcpConsult({
      prompt: "Keep the job handle after MCP logging disconnects.",
      idempotencyKey: "mcp-observation-error",
      waitTimeoutMs: 5_000,
      paths,
      sendLog: async () => {
        throw new Error("MCP host disconnected");
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      jobId: expect.stringMatching(/^job_/u),
      status: "observation-error",
      output: expect.stringContaining("remains durable"),
    });
    const jobId = result.structuredContent.jobId;
    if (!jobId) throw new Error("Missing durable MCP job handle");
    const client = new OracleClient({ socketPath: paths.socketPath });
    await client.waitForTerminal(jobId, { timeoutMs: 5_000 });
    client.close();
    expect(provider.sendCount(jobId)).toBe(1);
    await worker.stop();
  });

  test("exposes status, result, events, and explicit capture resume tools", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider({ captureFailures: 1 });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const prompt = await client.putObject(Buffer.from("Resume the captured job.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const spec: JobSpec = {
      schemaVersion: JOB_SCHEMA_VERSION,
      requestId: "mcp-job-tools",
      idempotency: { scope: "mcp-tools", key: "mcp-job-tools" },
      owner: { kind: "ordinary", sessionSlug: "mcp-job-tools" },
      input: { prompt, promptSha256: prompt.sha256 },
      route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
      policy: {
        maxCaptureMs: 60_000,
        allowAutomaticCaptureRecovery: true,
        allowAutomaticResend: false,
        requireCommittedBundleEvidence: false,
      },
    };
    const admitted = await client.admitJob(spec);
    await client.waitForState(admitted.job.id, "recoverable", { timeoutMs: 5_000 });

    const status = await runJobStatusTool({ jobId: admitted.job.id }, paths);
    expect(status.structuredContent).toMatchObject({ state: "recoverable" });
    expect(status.structuredContent).not.toHaveProperty("job");
    const events = await runJobEventsTool({ jobId: admitted.job.id, after: 0 }, paths);
    const eventList = events.structuredContent?.events;
    expect(Array.isArray(eventList) ? eventList.length : 0).toBeGreaterThan(0);
    expect(Array.isArray(eventList) ? eventList[0] : undefined).not.toHaveProperty("event");
    const before = await runJobResultTool({ jobId: admitted.job.id }, paths);
    expect(before.structuredContent).toMatchObject({ ready: false, state: "recoverable" });
    expect(before.structuredContent).not.toHaveProperty("result");
    const resumed = await runJobResumeTool({ jobId: admitted.job.id }, paths);
    expect(resumed.isError).toBeUndefined();
    await client.waitForTerminal(admitted.job.id, { timeoutMs: 5_000 });
    const result = await runJobResultTool({ jobId: admitted.job.id }, paths);
    expect(result.structuredContent).toMatchObject({
      ready: true,
      state: "completed",
      output: expect.stringMatching(/^Fake answer for/u),
    });
    expect(provider.sendCount(admitted.job.id)).toBe(1);

    client.close();
    await worker.stop();
  });

  test("rejects generic resume and abandon for Batch-owned jobs", async () => {
    const paths = workerPaths();
    const worker = new OracleWorker({ ...paths, provider: new FakeProvider() });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const prompt = await client.putObject(Buffer.from("Batch parent owns this job.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const spec: JobSpec = {
      schemaVersion: JOB_SCHEMA_VERSION,
      requestId: "batch-owned-job",
      idempotency: { scope: "batch:test", key: "batch-owned-job" },
      owner: { kind: "batch-lane", batchId: "batch-1", laneId: "lane-1", attempt: 1 },
      input: { prompt, promptSha256: prompt.sha256 },
      route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
      policy: {
        maxCaptureMs: 60_000,
        allowAutomaticCaptureRecovery: true,
        allowAutomaticResend: false,
        requireCommittedBundleEvidence: false,
      },
    };
    const admitted = await client.admitJob(spec);
    await expect(client.resumeJob(admitted.job.id)).rejects.toThrow(/batch-owned/u);
    await expect(client.abandonJob(admitted.job.id, "generic owner call")).rejects.toThrow(
      /batch-owned/u,
    );
    await client.waitForTerminal(admitted.job.id, { timeoutMs: 5_000 });

    client.close();
    await worker.stop();
  });
});
