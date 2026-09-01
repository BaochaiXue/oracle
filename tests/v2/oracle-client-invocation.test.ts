import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test as vitestTest } from "vitest";
import { FakeProvider, OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { admitOracleJob, OracleClient } from "../../packages/oracle-client/src/index.js";
import { ORACLE_V2_MAX_REQUEST_BODY_BYTES } from "../../packages/oracle-kernel/src/index.js";

const roots: string[] = [];
const test = process.platform === "win32" ? vitestTest.skip : vitestTest;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oracle v2 client invocation", () => {
  vitestTest("rejects an oversized object before writing a durable intent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-client-object-limit-"));
    roots.push(root);
    const intentDirectory = path.join(root, "intents");
    const unexpectedTransport = {
      putObject: async () => {
        throw new Error("unexpected object upload");
      },
      admitJob: async () => {
        throw new Error("unexpected admission");
      },
    };

    await expect(
      admitOracleJob(unexpectedTransport, {
        requestId: "oversized-client-object",
        idempotency: { scope: "cli", key: "oversized-client-object" },
        owner: { kind: "ordinary", sessionSlug: "oversized-client-object" },
        promptBytes: Buffer.from("Reject before intent.\n"),
        bundleBytes: Buffer.alloc(ORACLE_V2_MAX_REQUEST_BODY_BYTES + 1),
        intentDirectory,
      }),
    ).rejects.toThrow(/Oracle v2 bundle.*exceeding.*16777216 bytes/u);
    expect(existsSync(intentDirectory)).toBe(false);
  });

  test("persists intent before admission and reuses one job for the same logical request", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-client-invocation-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
    };
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const invocation = {
      requestId: "request-client-reconnect",
      idempotency: { scope: "cli", key: "request-client-reconnect" },
      owner: { kind: "ordinary" as const, sessionSlug: "client-reconnect" },
      promptBytes: Buffer.from("Review the sealed client invocation.\n", "utf8"),
      bundleBytes: Buffer.from("sealed source bytes\n", "utf8"),
      bundleMediaType: "text/plain",
      intentDirectory: path.join(root, "intents"),
    };

    const first = await admitOracleJob(client, invocation);
    const second = await admitOracleJob(client, invocation);
    expect(second.admission.created).toBe(false);
    expect(second.admission.job.id).toBe(first.admission.job.id);
    expect(statSync(first.intentPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.intentPath, "utf8"))).toMatchObject({
      schemaVersion: "oracle.client-intent.v2",
      requestId: invocation.requestId,
    });
    expect(statSync(first.admissionPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.admissionPath, "utf8"))).toMatchObject({
      schemaVersion: "oracle.client-admission.v2",
      jobId: first.admission.job.id,
    });
    const completed = await client.waitForTerminal(first.admission.job.id, { timeoutMs: 5_000 });
    expect(completed.state.kind).toBe("completed");
    expect(provider.sendCount(first.admission.job.id)).toBe(1);

    await expect(
      admitOracleJob(client, {
        ...invocation,
        promptBytes: Buffer.from("Changed prompt bytes.\n", "utf8"),
      }),
    ).rejects.toThrow("intent identity mismatch");
    await expect(
      admitOracleJob(client, {
        ...invocation,
        maxCaptureMs: 5_000,
      }),
    ).rejects.toThrow("intent identity mismatch");
    await expect(
      admitOracleJob(client, {
        ...invocation,
        bundleMediaType: "application/zip",
      }),
    ).rejects.toThrow("intent identity mismatch");
    client.close();
    await worker.stop();
  });

  test("atomically claims one canonical idempotency intent under concurrent callers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-client-intent-race-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
    };
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const base = {
      idempotency: { scope: "cli-race", key: "one-intent" },
      owner: { kind: "ordinary" as const, sessionSlug: "intent-race" },
      intentDirectory: path.join(root, "intents"),
    };
    const attempts = await Promise.allSettled([
      admitOracleJob(client, {
        ...base,
        requestId: "intent-race-a",
        promptBytes: Buffer.from("Concurrent payload A.\n"),
      }),
      admitOracleJob(client, {
        ...base,
        requestId: "intent-race-b",
        promptBytes: Buffer.from("Concurrent payload B.\n"),
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const admitted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (!admitted || admitted.status !== "fulfilled") throw new Error("Missing admitted race job");
    await client.waitForTerminal(admitted.value.admission.job.id, { timeoutMs: 5_000 });
    expect((await client.listJobs()).length).toBe(1);
    expect(provider.sendCount(admitted.value.admission.job.id)).toBe(1);

    client.close();
    await worker.stop();
  });
});
