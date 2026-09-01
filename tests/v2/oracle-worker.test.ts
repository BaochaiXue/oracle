import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  JOB_EVENT_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  type JobSpec,
  type ObjectRef,
} from "../../packages/oracle-kernel/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import { OracleStore } from "../../packages/oracle-store/src/index.js";
import {
  FakeProvider,
  OracleWorker,
  WorkerAlreadyRunningError,
} from "../../apps/oracle-worker/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workerPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-worker-"));
  roots.push(root);
  return {
    rootDir: path.join(root, "v2"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
  };
}

async function admit(client: OracleClient, key = "worker-job") {
  const prompt = await client.putObject(Buffer.from("Review this worker job.\n"), {
    mediaType: "text/plain",
    objectClass: "prompt",
  });
  return client.admitJob(jobSpec(prompt, key));
}

function jobSpec(
  prompt: Omit<ObjectRef, "objectClass"> & { objectClass: "prompt" },
  key: string,
): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: `request-${key}`,
    idempotency: { scope: "worker-test", key },
    owner: { kind: "ordinary", sessionSlug: key },
    input: { prompt, promptSha256: prompt.sha256 },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    policy: {
      maxCaptureMs: 60_000,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: false,
    },
  };
}

async function waitForIdle(client: OracleClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await client.getWorker();
    if (status.running === 0 && status.queued === 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Worker did not become idle: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Oracle v2 local worker protocol", () => {
  test("continues after the admitting client disconnects and exposes sequenced events", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();

    const admittingClient = new OracleClient({ socketPath: paths.socketPath });
    const admission = await admit(admittingClient);
    admittingClient.close();

    const reconnectingClient = new OracleClient({ socketPath: paths.socketPath });
    const completed = await reconnectingClient.waitForTerminal(admission.job.id, {
      timeoutMs: 5_000,
    });
    expect(completed).toMatchObject({
      state: { kind: "completed", submission: { jobId: admission.job.id } },
      projectionPending: false,
    });
    const events = await reconnectingClient.listEvents(admission.job.id, { after: 0 });
    expect(events.map((item) => item.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((item) => item.type)).toEqual([
      "job-admitted",
      "preparation-started",
      "preparation-completed",
      "dispatch-reserved",
      "dispatch-marked-at-risk",
      "submission-committed",
      "capture-started",
      "capture-completed",
    ]);
    expect(provider.sendCount(admission.job.id)).toBe(1);

    reconnectingClient.close();
    await worker.stop();
  });

  test("returns one job for duplicate client admission and enforces one socket owner", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });

    const first = await admit(client, "same-key");
    const second = await admit(client, "same-key");
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } });

    const otherPrompt = await client.putObject(Buffer.from("Different request.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    await expect(client.admitJob(jobSpec(otherPrompt, "same-key"))).rejects.toThrow(
      "idempotency_spec_conflict",
    );

    const contender = new OracleWorker({ ...paths, provider });
    await expect(contender.start()).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    expect((await client.getWorker()).ready).toBe(true);
    expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(paths.socketPath)).mode & 0o777).toBe(0o700);

    client.close();
    await worker.stop();
  });

  test("preserves the winner socket when two workers start simultaneously", async () => {
    const paths = workerPaths();
    const first = new OracleWorker({ ...paths, provider: new FakeProvider() });
    const second = new OracleWorker({ ...paths, provider: new FakeProvider() });
    const results = await Promise.allSettled([first.start(), second.start()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const client = new OracleClient({ socketPath: paths.socketPath });
    expect((await client.getWorker()).ready).toBe(true);
    client.close();
    if (results[0]?.status === "fulfilled") await first.stop();
    else await second.stop();
  });

  test("recovers an at-risk committed turn after restart without a second Send", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const firstWorker = new OracleWorker({
      ...paths,
      provider,
      faultInjector: {
        hit(point) {
          if (point === "immediately-after-click") throw new Error("Injected worker crash");
        },
      },
    });
    await firstWorker.start();
    const firstClient = new OracleClient({ socketPath: paths.socketPath });
    const admission = await admit(firstClient, "restart-recovery");
    const atRisk = await firstClient.waitForState(admission.job.id, "dispatch-at-risk", {
      timeoutMs: 5_000,
    });
    expect(atRisk.state.kind).toBe("dispatch-at-risk");
    expect(provider.sendCount(admission.job.id)).toBe(1);
    firstClient.close();
    await firstWorker.stop();

    const secondWorker = new OracleWorker({ ...paths, provider });
    await secondWorker.start();
    const secondClient = new OracleClient({ socketPath: paths.socketPath });
    const completed = await secondClient.waitForTerminal(admission.job.id, { timeoutMs: 5_000 });
    expect(completed.state.kind).toBe("completed");
    expect(provider.sendCount(admission.job.id)).toBe(1);

    secondClient.close();
    await secondWorker.stop();
  });

  test("scopes a capture fault to the intended job while older recoverable jobs resume", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const firstWorker = new OracleWorker({
      ...paths,
      provider,
      faultInjector: {
        hit(point) {
          if (point === "during-capture") throw new Error("Seed recoverable capture");
        },
      },
    });
    await firstWorker.start();
    const firstClient = new OracleClient({ socketPath: paths.socketPath });
    const older = await admit(firstClient, "older-recoverable");
    const olderRecoverable = await firstClient.waitForState(older.job.id, "recoverable", {
      timeoutMs: 5_000,
    });
    expect(olderRecoverable.state).toMatchObject({
      kind: "recoverable",
      basis: "committed-capture",
    });
    firstClient.close();
    await firstWorker.stop();

    const targetRequestId = "request-targeted-recovery";
    const secondWorker = new OracleWorker({
      ...paths,
      provider,
      faultInjector: {
        hit(point, context) {
          if (point === "during-capture" && context?.requestId === targetRequestId) {
            throw new Error("Targeted recoverable capture");
          }
        },
      },
    });
    await secondWorker.start();
    const secondClient = new OracleClient({ socketPath: paths.socketPath });
    const target = await admit(secondClient, "targeted-recovery");
    const [olderCompleted, targetRecoverable] = await Promise.all([
      secondClient.waitForTerminal(older.job.id, { timeoutMs: 5_000 }),
      secondClient.waitForState(target.job.id, "recoverable", { timeoutMs: 5_000 }),
    ]);
    expect(olderCompleted.state.kind).toBe("completed");
    expect(targetRecoverable.state).toMatchObject({
      kind: "recoverable",
      basis: "committed-capture",
    });
    expect(provider.sendCount(older.job.id)).toBe(1);
    expect(provider.sendCount(target.job.id)).toBe(1);
    secondClient.close();
    await secondWorker.stop();

    const thirdWorker = new OracleWorker({ ...paths, provider });
    await thirdWorker.start();
    const thirdClient = new OracleClient({ socketPath: paths.socketPath });
    const targetCompleted = await thirdClient.waitForTerminal(target.job.id, {
      timeoutMs: 5_000,
    });
    expect(targetCompleted.state.kind).toBe("completed");
    expect(provider.sendCount(target.job.id)).toBe(1);
    expect((await thirdClient.listEvents(target.job.id)).map((event) => event.type)).toEqual([
      "job-admitted",
      "preparation-started",
      "preparation-completed",
      "dispatch-reserved",
      "dispatch-marked-at-risk",
      "submission-committed",
      "capture-started",
      "capture-failed",
      "capture-started",
      "capture-completed",
    ]);
    thirdClient.close();
    await thirdWorker.stop();
  }, 30_000);

  test("records an explicit restart event before resuming a preparing job", async () => {
    const paths = workerPaths();
    const seedStore = new OracleStore(paths);
    const prompt = seedStore.putObject(Buffer.from("Resume preparation.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const admission = seedStore.admitJob(jobSpec(prompt, "preparing-restart"));
    seedStore.appendEvent(admission.job.id, admission.job.stateVersion, {
      schemaVersion: JOB_EVENT_SCHEMA_VERSION,
      type: "preparation-started",
      attempt: 1,
    });
    seedStore.close();

    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const completed = await client.waitForTerminal(admission.job.id, { timeoutMs: 5_000 });
    expect(completed.state.kind).toBe("completed");
    expect((await client.listEvents(admission.job.id)).map((item) => item.type)).toEqual([
      "job-admitted",
      "preparation-started",
      "preparation-deferred",
      "preparation-started",
      "preparation-completed",
      "dispatch-reserved",
      "dispatch-marked-at-risk",
      "submission-committed",
      "capture-started",
      "capture-completed",
    ]);
    expect(provider.sendCount(admission.job.id)).toBe(1);

    client.close();
    await worker.stop();
  });

  test("serializes preparation and dispatch while bounding concurrent capture at three", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider({
      preparationDelayMs: 5,
      dispatchDelayMs: 5,
      captureDelayMs: 750,
    });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const prompt = await client.putObject(Buffer.from("Concurrency check.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const admissions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        client.admitJob(jobSpec(prompt, `concurrency-${index}`)),
      ),
    );
    await Promise.all(
      admissions.map((admission) =>
        client.waitForTerminal(admission.job.id, { timeoutMs: 10_000 }),
      ),
    );
    expect(provider.maxConcurrentPreparations).toBe(1);
    expect(provider.maxConcurrentDispatches).toBe(1);
    expect(provider.maxConcurrentCaptures).toBeGreaterThan(1);
    expect(provider.maxConcurrentCaptures).toBeLessThanOrEqual(3);

    client.close();
    await worker.stop();
  }, 15_000);

  test("resumes committed capture only and abandons an ambiguous job without resending", async () => {
    const recoverablePaths = workerPaths();
    const recoverableProvider = new FakeProvider({ captureFailures: 1 });
    const recoverableWorker = new OracleWorker({
      ...recoverablePaths,
      provider: recoverableProvider,
    });
    await recoverableWorker.start();
    const recoverableClient = new OracleClient({ socketPath: recoverablePaths.socketPath });
    const recoverableAdmission = await admit(recoverableClient, "capture-resume");
    const recoverable = await recoverableClient.waitForState(
      recoverableAdmission.job.id,
      "recoverable",
      { timeoutMs: 5_000 },
    );
    expect(recoverable.state).toMatchObject({
      kind: "recoverable",
      basis: "committed-capture",
    });
    await recoverableClient.resumeJob(recoverableAdmission.job.id);
    const completed = await recoverableClient.waitForTerminal(recoverableAdmission.job.id, {
      timeoutMs: 5_000,
    });
    expect(completed.state.kind).toBe("completed");
    expect(recoverableProvider.sendCount(recoverableAdmission.job.id)).toBe(1);
    recoverableClient.close();
    await recoverableWorker.stop();

    const ambiguousPaths = workerPaths();
    const ambiguousProvider = new FakeProvider({ commitObservation: "missing" });
    const ambiguousWorker = new OracleWorker({ ...ambiguousPaths, provider: ambiguousProvider });
    await ambiguousWorker.start();
    const ambiguousClient = new OracleClient({ socketPath: ambiguousPaths.socketPath });
    const ambiguousAdmission = await admit(ambiguousClient, "owner-abandon");
    await ambiguousClient.waitForState(ambiguousAdmission.job.id, "ambiguous", {
      timeoutMs: 5_000,
    });
    await waitForIdle(ambiguousClient, 5_000);
    const abandoned = await ambiguousClient.abandonJob(
      ambiguousAdmission.job.id,
      "Owner closed the unresolved attempt",
    );
    expect(abandoned.state.kind).toBe("abandoned");
    expect(ambiguousProvider.sendCount(ambiguousAdmission.job.id)).toBe(1);
    ambiguousClient.close();
    await ambiguousWorker.stop();
  });

  test("accepts canary admission only through the canary owner contract", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const prompt = await client.putObject(Buffer.from("Canary contract.\n"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    await expect(client.admitCanary(jobSpec(prompt, "not-a-canary"))).rejects.toThrow(
      "canary_owner_required",
    );
    const spec: JobSpec = {
      ...jobSpec(prompt, "canary"),
      owner: { kind: "canary", canaryId: "fixture-canary" },
    };
    const admission = await client.admitCanary(spec);
    expect((await client.waitForTerminal(admission.job.id, { timeoutMs: 5_000 })).state.kind).toBe(
      "completed",
    );

    client.close();
    await worker.stop();
  });

  test("blocks before Send when final preparation verification fails", async () => {
    const paths = workerPaths();
    const provider = new FakeProvider({ verificationFailures: 1 });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });
    const admission = await admit(client, "verification-failure");
    const failed = await client.waitForTerminal(admission.job.id, { timeoutMs: 5_000 });
    expect(failed.state).toMatchObject({
      kind: "failed-unsent",
      retrySafe: true,
      failure: { externalEffectRisk: "none", retryPolicy: "safe-new-attempt" },
    });
    expect(provider.sendCount(admission.job.id)).toBe(0);

    client.close();
    await worker.stop();
  });

  test.skipIf(process.env.ORACLE_V2_SOAK !== "1")(
    "keeps a 1,000-job fake-provider run linear and bounded",
    async () => {
      const paths = workerPaths();
      const provider = new FakeProvider();
      const worker = new OracleWorker({ ...paths, provider });
      await worker.start();
      const client = new OracleClient({ socketPath: paths.socketPath });
      const prompt = await client.putObject(Buffer.from("Bounded soak.\n"), {
        mediaType: "text/plain",
        objectClass: "prompt",
      });

      for (let offset = 0; offset < 1_000; offset += 50) {
        await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            client.admitJob(jobSpec(prompt, `soak-${offset + index}`)),
          ),
        );
      }
      await waitForIdle(client, 120_000);
      const jobs = await client.listJobs();
      expect(jobs).toHaveLength(1_000);
      expect(jobs.every((job) => job.state.kind === "completed")).toBe(true);
      expect(jobs.every((job) => provider.sendCount(job.id) === 1)).toBe(true);
      expect(provider.maxConcurrentCaptures).toBeLessThanOrEqual(3);

      client.close();
      await worker.stop();
      const database = new DatabaseSync(path.join(paths.rootDir, "oracle.db"), {
        readOnly: true,
      });
      const counts = database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM job_events) AS events",
        )
        .get() as { jobs: number; events: number };
      database.close();
      expect(counts).toEqual({ jobs: 1_000, events: 8_000 });
      expect(statSync(path.join(paths.rootDir, "oracle.db")).size).toBeLessThan(64 * 1024 * 1024);
    },
    180_000,
  );
});
