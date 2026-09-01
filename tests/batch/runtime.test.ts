import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test as vitestTest, vi } from "vitest";
import {
  FakeProvider,
  OracleWorker,
  type OracleWorkerOptions,
} from "../../apps/oracle-worker/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import type {
  PreparationReceipt,
  ProviderDispatchContext,
  ProviderJobContext,
  SubmissionReceipt,
} from "../../packages/oracle-kernel/src/index.js";
import { readVerifiedBatchAnswer } from "../../src/batch/answers.js";
import { batchAttemptIdempotencyKey } from "../../src/batch/reconcile.js";
import {
  acceptMissingBatchLane,
  renderStoredBatch,
  resumeBatch,
  runBatch,
  type BatchJobClient,
} from "../../src/batch/runtime.js";
import { getBatchPaths, readBatchState } from "../../src/batch/store.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const test = process.platform === "win32" ? vitestTest.skip : vitestTest;

describe("Batch Oracle v2 runtime", () => {
  let home: string;
  let cwd: string;
  const workers = new Set<OracleWorker>();
  const clients = new Set<OracleClient>();

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-v2-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-v2-cwd-"));
    await fs.writeFile(path.join(cwd, "authority.md"), "# Canonical authority\n", "utf8");
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.clear();
    for (const worker of workers) await worker.stop().catch(() => undefined);
    workers.clear();
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("runs a three-lane blind Batch, crosses one barrier, synthesizes, and receipts every job", async () => {
    await writeManifest(cwd, threeLaneManifest(true));
    const provider = new FakeProvider({
      preparationDelayMs: 5,
      dispatchDelayMs: 5,
      captureDelayMs: 20,
    });
    const harness = await startHarness(home, provider, workers, clients);
    const logs: string[] = [];
    const result = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 3, log: (message) => logs.push(message) },
      { client: harness.client },
    );

    expect(result.state.status).toBe("completed");
    expect(result.state.barrierClosedAt).toBeTruthy();
    expect(result.state.lanes).toHaveLength(3);
    expect(result.state.lanes.every((lane) => lane.status === "completed" && lane.jobId)).toBe(
      true,
    );
    expect(result.state.synthesis).toEqual(
      expect.objectContaining({ status: "completed", jobId: expect.any(String) }),
    );
    expect(provider.maxConcurrentDispatches).toBe(1);
    expect(provider.maxConcurrentCaptures).toBeLessThanOrEqual(3);

    const paths = getBatchPaths(result.state.batchId);
    for (const lane of result.state.lanes) {
      const attempt = lane.attempts[0]!;
      const job = await harness.client.getJob(lane.jobId!);
      expect(job.spec.owner).toEqual({
        kind: "batch-lane",
        batchId: result.state.batchId,
        laneId: lane.id,
        attempt: 1,
      });
      expect(job.spec.idempotency).toEqual({
        scope: "oracle-batch",
        key: batchAttemptIdempotencyKey(result.state.batchId, lane.id, "lane", 1),
      });
      expect(job.spec.input.bundle?.mediaType).toBe("text/plain");
      expect(attempt.jobId).toBe(lane.jobId);
      expect(provider.sendCount(lane.jobId!)).toBe(1);
      const prompt = await fs.readFile(
        path.join(paths.inputs, "lanes", lane.id, "prompt.txt"),
        "utf8",
      );
      expect(prompt).toContain("BATCH ORACLE — BLIND FIRST PASS");
      expect(prompt).toContain("Do not assume sibling findings");
      expect(prompt).not.toContain("Fake answer for");
      const verified = await readVerifiedBatchAnswer(result.state.batchId, lane);
      expect(verified.receipt).toEqual(
        expect.objectContaining({
          jobId: lane.jobId,
          answerObjectSha256: lane.outputSha256,
          inputManifestSha256: lane.inputManifestSha256,
        }),
      );
    }

    const synthesis = result.state.synthesis!;
    const synthesisJob = await harness.client.getJob(synthesis.jobId!);
    expect(synthesisJob.spec.owner).toEqual({
      kind: "batch-synthesis",
      batchId: result.state.batchId,
      attempt: 1,
    });
    expect(synthesisJob.spec.idempotency.key).toBe(
      batchAttemptIdempotencyKey(result.state.batchId, synthesis.id, "synthesis", 1),
    );
    expect(provider.sendCount(synthesis.jobId!)).toBe(1);
    expect(Date.parse(synthesisJob.createdAt)).toBeGreaterThanOrEqual(
      Math.max(
        ...(
          await Promise.all(result.state.lanes.map((lane) => harness.client.getJob(lane.jobId!)))
        ).map((job) => Date.parse(job.createdAt)),
      ),
    );
    const synthesisPrompt = await fs.readFile(
      path.join(paths.inputs, "synthesis", "prompt.txt"),
      "utf8",
    );
    expect(synthesisPrompt).toContain("BATCH ORACLE — CONTRADICTION-FIRST SYNTHESIS");
    const synthesisAttachmentDir = path.join(paths.inputs, "synthesis", "attachments");
    const synthesisBundle = (
      await Promise.all(
        (
          await fs.readdir(synthesisAttachmentDir)
        ).map((name) => fs.readFile(path.join(synthesisAttachmentDir, name), "utf8")),
      )
    ).join("\n");
    for (const lane of result.state.lanes) {
      expect(synthesisBundle).toContain(`Fake answer for ${lane.jobId}`);
    }
    expect(logs.join("\n")).not.toContain("Fake answer for");
    const rendered = await renderStoredBatch(result.state.batchId, { all: true });
    expect(rendered.indexOf("Raw answer: constitution")).toBeLessThan(
      rendered.indexOf("Raw answer: cognition"),
    );
    expect(rendered.indexOf("Raw answer: cognition")).toBeLessThan(
      rendered.indexOf("Raw answer: tribunal"),
    );
  }, 20_000);

  test("recovers one committed lane through a worker restart without a second Send", async () => {
    await writeManifest(cwd, threeLaneManifest(true));
    const firstProvider = new FakeProvider({ captureFailures: 1, captureDelayMs: 10 });
    const paths = workerPaths(home);
    const first = await startHarness(home, firstProvider, workers, clients, paths);
    const initial = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 3, log: () => undefined },
      { client: first.client },
    );
    expect(initial.state.status).toBe("awaiting-recovery");
    const recoverableLane = initial.state.lanes.find((lane) => lane.status === "recoverable");
    expect(recoverableLane).toEqual(
      expect.objectContaining({ jobId: expect.any(String), attempts: [expect.any(Object)] }),
    );
    expect(recoverableLane?.lastError?.retrySafe).toBe(false);
    await expect(first.client.resumeJob(recoverableLane!.jobId!)).rejects.toThrow(
      /outside its parent/u,
    );
    await expect(
      first.client.resumeBatchJob(recoverableLane!.jobId!, {
        kind: "batch-lane",
        batchId: initial.state.batchId,
        laneId: "wrong-lane",
        attempt: 1,
      }),
    ).rejects.toThrow(/mismatched parent identity/u);
    await expect(
      first.client.abandonJob(recoverableLane!.jobId!, "generic close is forbidden"),
    ).rejects.toThrow(/outside its parent/u);
    const originalJobId = recoverableLane!.jobId!;
    expect(firstProvider.sendCount(originalJobId)).toBe(1);

    first.client.close();
    clients.delete(first.client);
    await first.worker.stop();
    workers.delete(first.worker);

    const secondProvider = new FakeProvider();
    const second = await startHarness(home, secondProvider, workers, clients, paths);
    const resumed = await resumeBatch(
      initial.state.batchId,
      { log: () => undefined },
      { client: second.client },
    );
    expect(resumed.state.status).toBe("completed");
    const recovered = resumed.state.lanes.find((lane) => lane.id === recoverableLane!.id)!;
    expect(recovered.jobId).toBe(originalJobId);
    expect(recovered.attempts).toHaveLength(1);
    expect(secondProvider.sendCount(originalJobId)).toBe(0);
    expect(firstProvider.sendCount(originalJobId)).toBe(1);
    expect(resumed.state.synthesis?.jobId).toBeTruthy();
    expect(secondProvider.sendCount(resumed.state.synthesis!.jobId!)).toBe(1);
  }, 20_000);

  test("creates a safe next attempt only after explicit Batch resume of failed-unsent", async () => {
    await writeManifest(cwd, twoLaneManifest(false));
    const provider = new FirstLaneVerificationFailureProvider();
    const harness = await startHarness(home, provider, workers, clients);
    const initial = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 2, log: () => undefined },
      { client: harness.client },
    );
    expect(initial.state.status).toBe("awaiting-recovery");
    const failed = initial.state.lanes.find((lane) => lane.id === "one")!;
    expect(failed).toEqual(
      expect.objectContaining({
        status: "recoverable",
        lastError: expect.objectContaining({ retrySafe: true }),
      }),
    );
    const firstJobId = failed.jobId!;
    expect(provider.sendCount(firstJobId)).toBe(0);
    expect(failed.attempts).toHaveLength(1);

    const resumed = await resumeBatch(
      initial.state.batchId,
      { log: () => undefined },
      { client: harness.client },
    );
    expect(resumed.state.status).toBe("completed");
    const recovered = resumed.state.lanes.find((lane) => lane.id === "one")!;
    expect(recovered.attempts).toHaveLength(2);
    expect(recovered.jobId).not.toBe(firstJobId);
    expect(recovered.attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      batchAttemptIdempotencyKey(resumed.state.batchId, "one", "lane", 1),
      batchAttemptIdempotencyKey(resumed.state.batchId, "one", "lane", 2),
    ]);
    expect(provider.sendCount(firstJobId)).toBe(0);
    expect(provider.sendCount(recovered.jobId!)).toBe(1);
    expect(resumed.state.lanes.find((lane) => lane.id === "two")?.attempts).toHaveLength(1);
  }, 15_000);

  test("re-observes a committed admission with the same idempotency key after its response is lost", async () => {
    await writeManifest(cwd, twoLaneManifest(false));
    const provider = new FakeProvider();
    const harness = await startHarness(home, provider, workers, clients);
    let loseFirstAdmissionResponse = true;
    const lossyClient: BatchJobClient = {
      putObject: harness.client.putObject.bind(harness.client),
      admitJob: async (spec) => {
        const admission = await harness.client.admitJob(spec);
        if (loseFirstAdmissionResponse) {
          loseFirstAdmissionResponse = false;
          throw new Error("Injected lost admission response after durable server commit");
        }
        return admission;
      },
      getJob: harness.client.getJob.bind(harness.client),
      getResult: harness.client.getResult.bind(harness.client),
      resumeBatchJob: harness.client.resumeBatchJob.bind(harness.client),
      abandonBatchJob: harness.client.abandonBatchJob.bind(harness.client),
    };

    const initial = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 2, log: () => undefined },
      { client: lossyClient },
    );
    expect(initial.state.status).toBe("awaiting-recovery");
    const unobserved = initial.state.lanes.find((lane) => !lane.jobId)!;
    expect(unobserved).toMatchObject({
      status: "recoverable",
      lastError: { code: "batch-job-admission-unobserved", retrySafe: false },
      attempts: [{ attempt: 1, phase: "created" }],
    });
    expect(await harness.client.listJobs()).toHaveLength(2);

    const resumed = await resumeBatch(
      initial.state.batchId,
      { log: () => undefined },
      { client: lossyClient },
    );
    expect(resumed.state.status).toBe("completed");
    expect(await harness.client.listJobs()).toHaveLength(2);
    for (const lane of resumed.state.lanes) {
      expect(lane.attempts).toHaveLength(1);
      expect(lane.jobId).toBeTruthy();
      expect(provider.sendCount(lane.jobId!)).toBe(1);
    }
  }, 20_000);

  test("owner accept-missing closes one ambiguous lane and permits explicit partial synthesis", async () => {
    await writeManifest(cwd, twoLaneManifest(true));
    const provider = new OneLaneAmbiguousProvider("two");
    const harness = await startHarness(home, provider, workers, clients);
    const initial = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 2, log: () => undefined },
      { client: harness.client },
    );
    expect(initial.state.status).toBe("awaiting-owner");
    expect(initial.state.lanes.find((lane) => lane.id === "one")?.status).toBe("completed");
    const ambiguous = initial.state.lanes.find((lane) => lane.id === "two")!;
    expect(ambiguous.status).toBe("indeterminate");
    expect(initial.state.synthesis?.jobId).toBeUndefined();
    await waitForIdle(harness.client);

    const accepted = await acceptMissingBatchLane(
      initial.state.batchId,
      "two",
      "Owner accepts the missing second perspective.",
      { client: harness.client },
    );
    expect(accepted.lanes.find((lane) => lane.id === "two")).toEqual(
      expect.objectContaining({ status: "abandoned", acceptedMissing: true }),
    );
    expect((await harness.client.getJob(ambiguous.jobId!)).state.kind).toBe("abandoned");

    const resumed = await resumeBatch(
      initial.state.batchId,
      { allowPartial: true, log: () => undefined },
      { client: harness.client },
    );
    expect(resumed.state.status).toBe("partial");
    expect(resumed.state.synthesis).toEqual(
      expect.objectContaining({ status: "completed", jobId: expect.any(String) }),
    );
    expect(provider.sendCount(ambiguous.jobId!)).toBe(1);
    expect(provider.sendCount(resumed.state.synthesis!.jobId!)).toBe(1);
    const synthesisPrompt = await fs.readFile(
      path.join(getBatchPaths(resumed.state.batchId).inputs, "synthesis", "prompt.txt"),
      "utf8",
    );
    expect(synthesisPrompt).toContain("Missing or unavailable lanes: two (abandoned)");
  }, 15_000);

  vitestTest("sealing failure records zero admitted jobs", async () => {
    await writeManifest(cwd, twoLaneManifest(false));
    const logs: string[] = [];
    await expect(
      runBatch(
        "batch.json5",
        { cwd, log: (message) => logs.push(message) },
        {
          assemblePrompt: vi.fn(async () => {
            throw new Error("seal exploded");
          }),
        },
      ),
    ).rejects.toThrow(/failed before dispatch/u);
    const batchId = logs[0]!.replace("Batch ID: ", "");
    const state = await readBatchState(batchId);
    expect(state.status).toBe("error");
    expect(state.lanes.every((lane) => !lane.jobId && lane.attempts.length === 0)).toBe(true);
  });

  test("preserves a sealed binary source set as one ZIP bundle object", async () => {
    await fs.writeFile(
      path.join(cwd, "evidence.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const batch = twoLaneManifest(false);
    batch.sharedAuthority.files = ["evidence.png"];
    await writeManifest(cwd, batch);
    const provider = new FakeProvider();
    const harness = await startHarness(home, provider, workers, clients);
    const result = await runBatch(
      "batch.json5",
      { cwd, log: () => undefined },
      { client: harness.client },
    );
    expect(result.state.status).toBe("completed");
    for (const lane of result.state.lanes) {
      const job = await harness.client.getJob(lane.jobId!);
      expect(job.spec.input.bundle?.mediaType).toBe("application/zip");
      expect(provider.sendCount(lane.jobId!)).toBe(1);
    }
  });
});

class FirstLaneVerificationFailureProvider extends FakeProvider {
  private failed = false;

  override async verifyPrepared(
    context?: ProviderJobContext,
    _receipt?: PreparationReceipt,
  ): Promise<void> {
    if (
      !this.failed &&
      context?.spec.owner.kind === "batch-lane" &&
      context.spec.owner.laneId === "one" &&
      context.spec.owner.attempt === 1
    ) {
      this.failed = true;
      throw new Error("Injected first-lane final verification failure");
    }
    await super.verifyPrepared();
  }
}

class OneLaneAmbiguousProvider extends FakeProvider {
  constructor(private readonly ambiguousLaneId: string) {
    super();
  }

  override async observeCommit(
    context: ProviderDispatchContext,
  ): Promise<SubmissionReceipt | undefined> {
    if (
      context.spec.owner.kind === "batch-lane" &&
      context.spec.owner.laneId === this.ambiguousLaneId
    ) {
      return undefined;
    }
    return super.observeCommit(context);
  }
}

async function startHarness(
  home: string,
  provider: FakeProvider,
  workers: Set<OracleWorker>,
  clients: Set<OracleClient>,
  paths = workerPaths(home),
): Promise<{ worker: OracleWorker; client: OracleClient; paths: OracleWorkerOptions }> {
  const worker = new OracleWorker({ ...paths, provider });
  await worker.start();
  const client = new OracleClient({ socketPath: paths.socketPath });
  workers.add(worker);
  clients.add(client);
  return { worker, client, paths };
}

function workerPaths(home: string): OracleWorkerOptions {
  return {
    rootDir: path.join(home, "v2"),
    sessionsDir: path.join(home, "sessions"),
    socketPath: path.join(home, "v2", "run", "oracle.sock"),
    provider: new FakeProvider(),
  };
}

async function waitForIdle(client: OracleClient, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await client.getWorker();
    if (status.running === 0 && status.queued === 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Worker did not become idle: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeManifest(cwd: string, manifest: unknown): Promise<void> {
  await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(manifest), "utf8");
}

function threeLaneManifest(withSynthesis: boolean) {
  return manifest(
    [
      lane("constitution", "Review constitutional invariants."),
      lane("cognition", "Review recovery semantics."),
      lane("tribunal", "Review owner authority."),
    ],
    withSynthesis,
  );
}

function twoLaneManifest(withSynthesis: boolean) {
  return manifest(
    [lane("one", "Review the first perspective."), lane("two", "Review the second perspective.")],
    withSynthesis,
  );
}

function manifest(lanes: ReturnType<typeof lane>[], withSynthesis: boolean) {
  return {
    schemaVersion: "oracle.batch.v1",
    slug: "runtime-batch",
    project: "fixture",
    objective: "Exercise the v2 Batch job barrier.",
    sharedAuthority: {
      revisionLabel: "fixture-head",
      files: ["authority.md"],
    },
    policy: {
      maxParallel: 3,
      maxChildSessions: lanes.length + (withSynthesis ? 1 : 0),
      partialSynthesis: "owner-explicit",
      revealLaneAnswersBeforeBarrier: false,
    },
    lanes,
    ...(withSynthesis
      ? {
          synthesis: {
            id: "adjudication",
            title: "Adjudication",
            prompt: "Adjudicate contradictions without flattening dissent.",
            requiredOutput: ["contradiction matrix"],
          },
        }
      : {}),
  };
}

function lane(id: string, prompt: string) {
  return {
    id,
    title: id,
    mandate: `Mandate ${id}`,
    whyThisLane: `Why ${id}`,
    falsificationTarget: `Falsify ${id}`,
    prompt,
    outputContract: [`Output ${id}`],
  };
}
