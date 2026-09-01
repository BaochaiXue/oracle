import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  admitOracleJob,
  OracleClient,
  type ClientJob,
  type ClientJobResult,
} from "../../packages/oracle-client/src/index.js";
import type { JobSpec, JobStateKind } from "../../packages/oracle-kernel/src/index.js";
import { loadUserConfig, type UserConfig } from "../config.js";
import { resolveBrokerPaths } from "../v2/broker.js";
import {
  BatchAnswerIntegrityError,
  getAnswerReceiptPath,
  readVerifiedBatchAnswer,
} from "./answers.js";
import { detectAdmittedSourceDrift, loadBatchManifest, snapshotBatchSources } from "./manifest.js";
import {
  batchAttemptIdempotencyKey,
  classifyParentStatus,
  reconcileBatchState,
} from "./reconcile.js";
import { buildBatchStatusProjection, renderBatch } from "./render.js";
import { runBoundedScheduler } from "./scheduler.js";
import { loadSealedPromptArtifacts, sealFirstStageInputs, type SealBatchDeps } from "./seal.js";
import {
  createBatchId,
  getBatchPaths,
  initializeBatchStore,
  listBatchStates,
  mutateBatchState,
  readBatchState,
  readNormalizedBatchManifest,
  writeBatchState,
  writeJsonAtomic,
  writeOwnerFileAtomic,
} from "./store.js";
import { BatchSynthesisInputTooLargeError, sealSynthesisInput } from "./synthesis.js";
import type {
  BatchAnswerReceiptV1,
  BatchFirstStageSealV1,
  BatchLaneAttempt,
  BatchLaneState,
  BatchStateV1,
  LoadedBatchManifest,
} from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

const DEFAULT_BATCH_MAX_PARALLEL = 3;
const DEFAULT_BATCH_MAX_CHILD_SESSIONS = 5;
const MAX_BATCH_ADMISSION_PARALLEL = 3;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OBSERVATION_POLL_MS = 250;
const BATCH_SETTLED_JOB_STATES = new Set<JobStateKind>([
  "completed",
  "recoverable",
  "failed-unsent",
  "canceled-unsent",
  "abandoned",
  "ambiguous",
]);

export type BatchJobClient = Pick<
  OracleClient,
  "putObject" | "admitJob" | "getJob" | "getResult" | "resumeBatchJob" | "abandonBatchJob"
>;

export interface BatchRuntimeDeps {
  client?: BatchJobClient;
  assemblePrompt?: SealBatchDeps["assemblePrompt"];
}

export interface RunBatchOptions {
  cwd?: string;
  maxParallel?: number;
  observationTimeoutMs?: number;
  observationPollMs?: number;
  log?: (message: string) => void;
}

export interface BatchRunResult {
  state: BatchStateV1;
  reportPath: string;
}

interface AdmissionAction {
  laneId: string;
  role: "lane" | "synthesis";
  attempt: number;
  claimToken: string;
}

export async function validateBatchFile(manifestPath: string, options: { cwd?: string } = {}) {
  const config = (await loadUserConfig({ cwd: options.cwd })).config;
  const maxChildSessions = resolvePositiveInt(
    config.batch?.maxChildSessions,
    DEFAULT_BATCH_MAX_CHILD_SESSIONS,
  );
  return loadBatchManifest(manifestPath, { cwd: options.cwd, maxChildSessions });
}

export async function runBatch(
  manifestPath: string,
  options: RunBatchOptions = {},
  deps: BatchRuntimeDeps = {},
): Promise<BatchRunResult> {
  const log = options.log ?? console.log;
  const config = (await loadUserConfig({ cwd: options.cwd })).config;
  assertBatchEnabled(config);
  const localChildCap = resolvePositiveInt(
    config.batch?.maxChildSessions,
    DEFAULT_BATCH_MAX_CHILD_SESSIONS,
  );
  const loaded = await loadBatchManifest(manifestPath, {
    cwd: options.cwd,
    maxChildSessions: localChildCap,
  });
  const caps = resolveEffectiveCaps(loaded, config, options.maxParallel);
  const batchId = createBatchId(loaded.manifest.slug);
  log(`Batch ID: ${batchId}`);
  let state = await initializeBatchStore({
    loaded,
    batchId,
    effectiveMaxParallel: caps.maxParallel,
    effectiveMaxChildSessions: caps.maxChildSessions,
  });
  try {
    const snapshot = await snapshotBatchSources(loaded, batchId);
    state = {
      ...state,
      sourceManifestSha256: snapshot.manifest.snapshotManifestSha256,
      sourceSnapshotManifestSha256: snapshot.manifest.snapshotManifestSha256,
    };
    await writeBatchState(state);
    const sealed = await sealFirstStageInputs(loaded, batchId, {
      assemblePrompt: deps.assemblePrompt,
    });
    const sealReceipt: BatchFirstStageSealV1 = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId,
      sealedAt: new Date().toISOString(),
      sourceSnapshotManifestSha256: snapshot.manifest.snapshotManifestSha256!,
      lanes: sealed.map((entry) => ({
        id: entry.laneId,
        inputManifestSha256: entry.inputManifest.inputManifestSha256,
      })),
    };
    await writeJsonAtomic(getBatchPaths(batchId).firstStageSeal, sealReceipt);
    state = {
      ...state,
      status: "sealed",
      lanes: state.lanes.map((lane) => {
        const input = sealed.find((entry) => entry.laneId === lane.id)!;
        return {
          ...lane,
          status: "sealed",
          inputManifestSha256: input.inputManifest.inputManifestSha256,
          inputManifestPath: input.inputManifestPath,
          outputPath: answerOutputPath(batchId, lane.id, "lane"),
        };
      }),
    };
    await writeBatchState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = {
      ...state,
      status: "error",
      lastError: { code: "batch-input-sealing-failed", message },
    };
    await writeBatchState(state);
    throw new Error(`Batch ${batchId} failed before dispatch: ${message}`);
  }

  const connection = openBatchClient(deps);
  try {
    const actions = await prepareAdmissionActions(batchId, "lane");
    await admitActions(batchId, actions, connection.client, options);
    await observeMappedJobs(batchId, connection.client, options);
    return advanceBatch(batchId, connection.client, options, deps);
  } finally {
    connection.close();
  }
}

export async function resumeBatch(
  batchId: string,
  options: RunBatchOptions & { allowPartial?: boolean } = {},
  deps: BatchRuntimeDeps = {},
): Promise<BatchRunResult> {
  let state = await readBatchState(batchId);
  const config = (await loadUserConfig({ cwd: state.cwd })).config;
  assertBatchEnabled(config);
  if (["completed", "partial"].includes(state.status)) return finalizeReport(state);
  if (state.status === "preparing") state = await recoverFirstStageSeal(state);
  if (
    state.status === "error" &&
    state.lanes.every((lane) => !lane.jobId && !lane.sessionId) &&
    ["batch-input-sealing-failed", "batch-first-stage-seal-incomplete"].includes(
      state.lastError?.code ?? "",
    )
  ) {
    return finalizeReport(state);
  }
  assertNoLegacyExecutionState(state);

  const connection = openBatchClient(deps);
  try {
    state = await mutateBatchState(batchId, async (current) =>
      refreshAdmittedSourceDrift(await reconcileBatchState(current, connection.client)),
    );
    state = await recoverCompletedEvidence(state, connection.client);
    if (options.allowPartial) state = await recordAllowPartialDecision(state);
    await prepareOwnerResume(state, connection.client);
    const laneActions = await prepareAdmissionActions(batchId, "lane");
    const synthesisActions = (await readBatchState(batchId)).barrierClosedAt
      ? await prepareAdmissionActions(batchId, "synthesis")
      : [];
    const actions = [...laneActions, ...synthesisActions];
    if (actions.length > 0) {
      (options.log ?? console.log)(
        `Admitting ${actions.length} Batch attempt${actions.length === 1 ? "" : "s"}.`,
      );
      await admitActions(batchId, actions, connection.client, options);
    }
    await observeMappedJobs(batchId, connection.client, options);
    return advanceBatch(batchId, connection.client, options, deps);
  } finally {
    connection.close();
  }
}

export async function acceptMissingBatchLane(
  batchId: string,
  laneId: string,
  reason: string,
  deps: BatchRuntimeDeps = {},
): Promise<BatchStateV1> {
  const normalizedReason = requireOwnerReason(reason);
  const state = await readBatchState(batchId);
  const lane = state.lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Unknown batch lane: ${laneId}`);
  if (lane.status === "completed") throw new Error(`Lane ${laneId} already completed.`);
  if (lane.acceptedMissing) return state;
  const connection = openBatchClient(deps);
  try {
    await closeOwnedJobForMissing(connection.client, state, lane, normalizedReason);
  } finally {
    connection.close();
  }
  return mutateBatchState(batchId, (current) => {
    const currentLane = current.lanes.find((entry) => entry.id === laneId);
    if (!currentLane) throw new Error(`Unknown batch lane: ${laneId}`);
    if (currentLane.status === "completed") throw new Error(`Lane ${laneId} already completed.`);
    if (currentLane.acceptedMissing) return current;
    const decidedAt = new Date().toISOString();
    return {
      ...current,
      status: "awaiting-owner",
      lanes: current.lanes.map((entry) =>
        entry.id === laneId
          ? abandonLane(entry, decidedAt, normalizedReason, "batch-lane-accepted-missing")
          : entry,
      ),
      ownerDecisions: [
        ...(current.ownerDecisions ?? []),
        {
          type: "accept-missing" as const,
          decidedAt,
          laneId,
          stageId: laneId,
          stageRole: "lane" as const,
          reason: normalizedReason,
          jobId: currentLane.jobId,
          sessionId: currentLane.sessionId,
          missingLaneIds: [laneId],
        },
      ],
    };
  });
}

export async function acceptMissingBatchSynthesis(
  batchId: string,
  reason: string,
  deps: BatchRuntimeDeps = {},
): Promise<BatchStateV1> {
  const normalizedReason = requireOwnerReason(reason);
  const initial = await readBatchState(batchId);
  const synthesis = initial.synthesis;
  if (!synthesis) throw new Error(`Batch ${batchId} has no synthesis stage.`);
  if (synthesis.status === "completed")
    throw new Error(`Synthesis ${synthesis.id} already completed.`);
  if (synthesis.acceptedMissing || synthesis.status === "abandoned") return initial;
  if (
    !initial.barrierClosedAt ||
    initial.lanes.some((lane) => lane.status !== "completed" && !lane.acceptedMissing)
  ) {
    throw new Error("Synthesis cannot be closed before the first-stage barrier is complete.");
  }
  if (!["recoverable", "error", "indeterminate"].includes(synthesis.status)) {
    throw new Error(
      `Synthesis ${synthesis.id} is ${synthesis.status}; owner closure requires recoverable, error, or indeterminate state.`,
    );
  }
  const connection = openBatchClient(deps);
  try {
    await closeOwnedJobForMissing(connection.client, initial, synthesis, normalizedReason);
  } finally {
    connection.close();
  }
  const state = await mutateBatchState(batchId, (current) => {
    if (!current.synthesis) throw new Error(`Batch ${batchId} has no synthesis stage.`);
    if (current.synthesis.status === "completed") {
      throw new Error(`Synthesis ${current.synthesis.id} already completed.`);
    }
    if (current.synthesis.acceptedMissing || current.synthesis.status === "abandoned")
      return current;
    const decidedAt = new Date().toISOString();
    return {
      ...current,
      status: "partial",
      synthesis: abandonLane(
        current.synthesis,
        decidedAt,
        normalizedReason,
        "batch-synthesis-accepted-missing",
      ),
      ownerDecisions: [
        ...(current.ownerDecisions ?? []),
        {
          type: "accept-missing" as const,
          decidedAt,
          stageId: current.synthesis.id,
          stageRole: "synthesis" as const,
          reason: normalizedReason,
          jobId: current.synthesis.jobId,
          sessionId: current.synthesis.sessionId,
          missingLaneIds: [],
        },
      ],
    };
  });
  await finalizeReport(state);
  return state;
}

export async function getBatchStatus(batchId: string, deps: BatchRuntimeDeps = {}) {
  const connection = openBatchClient(deps);
  try {
    let state = await mutateBatchState(batchId, async (current) => {
      const reconciled = await refreshAdmittedSourceDrift(
        await reconcileBatchState(current, connection.client),
      );
      return { ...reconciled, status: classifyParentStatus(reconciled) };
    });
    state = await recoverCompletedEvidence(state, connection.client);
    return { state, projection: buildBatchStatusProjection(state) };
  } finally {
    connection.close();
  }
}

export async function listRecentBatches(hours = 72): Promise<BatchStateV1[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1_000;
  return (await listBatchStates()).filter((state) => Date.parse(state.createdAt) >= cutoff);
}

export async function renderStoredBatch(
  batchId: string,
  options: { laneId?: string; all?: boolean } = {},
): Promise<string> {
  const [manifest, state] = await Promise.all([
    readNormalizedBatchManifest(batchId),
    readBatchState(batchId),
  ]);
  return renderBatch(manifest, state, options);
}

async function prepareAdmissionActions(
  batchId: string,
  role: "lane" | "synthesis",
): Promise<AdmissionAction[]> {
  const actions: AdmissionAction[] = [];
  await mutateBatchState(batchId, (state) => {
    const reserve = (lane: BatchLaneState): BatchLaneState => {
      if (lane.role !== role) return lane;
      if (
        lane.acceptedMissing ||
        lane.jobId ||
        lane.sessionId ||
        ["completed", "error", "indeterminate", "abandoned"].includes(lane.status)
      ) {
        return lane;
      }
      if (lane.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid)) return lane;
      const attemptNumber = lane.attempts.at(-1)?.attempt ?? 1;
      const idempotencyKey = batchAttemptIdempotencyKey(
        state.batchId,
        lane.id,
        lane.role,
        attemptNumber,
      );
      const latest = lane.attempts.at(-1);
      const attempts: BatchLaneAttempt[] = latest
        ? lane.attempts.map((attempt, index) =>
            index === lane.attempts.length - 1
              ? {
                  ...attempt,
                  idempotencyKey,
                  phase: "claimed" as const,
                  claimedAt: new Date().toISOString(),
                }
              : attempt,
          )
        : [
            {
              attempt: attemptNumber,
              idempotencyKey,
              createdAt: new Date().toISOString(),
              phase: "claimed" as const,
              claimedAt: new Date().toISOString(),
            },
          ];
      const claimToken = createHash("sha256")
        .update(
          `${process.pid}\0${state.batchId}\0${lane.role}\0${lane.id}\0${Date.now()}\0${Math.random()}`,
        )
        .digest("hex");
      actions.push({ laneId: lane.id, role: lane.role, attempt: attemptNumber, claimToken });
      return {
        ...lane,
        status: "claimed",
        outputPath: lane.outputPath ?? answerOutputPath(state.batchId, lane.id, lane.role),
        attempts,
        dispatchReservation: {
          pid: process.pid,
          token: claimToken,
          reservedAt: new Date().toISOString(),
        },
      };
    };
    return {
      ...state,
      status: role === "synthesis" ? "synthesizing" : "running",
      lanes: state.lanes.map(reserve),
      ...(state.synthesis ? { synthesis: reserve(state.synthesis) } : {}),
    };
  });
  return actions;
}

async function admitActions(
  batchId: string,
  actions: AdmissionAction[],
  client: BatchJobClient,
  options: RunBatchOptions,
): Promise<void> {
  if (actions.length === 0) return;
  const state = await readBatchState(batchId);
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", onInterrupt);
  try {
    await runBoundedScheduler(actions, {
      maxParallel: state.effectiveMaxParallel,
      shouldStart: () => !interrupted,
      onStart: (action) => {
        (options.log ?? console.log)(
          `Admitting ${action.role} ${action.laneId} attempt ${action.attempt}...`,
        );
      },
      worker: (action) => admitAction(batchId, action, client),
      onSettled: async (action, result) => {
        if (result.status === "fulfilled") return;
        await markAdmissionUnobserved(batchId, action, result.reason);
      },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  if (interrupted) {
    await mutateBatchState(batchId, (current) => ({ ...current, status: "interrupted" }));
  }
}

async function admitAction(
  batchId: string,
  action: AdmissionAction,
  client: BatchJobClient,
): Promise<ClientJob> {
  const state = await readBatchState(batchId);
  const lane = findLane(state, action.laneId, action.role);
  assertAdmissionClaim(lane, action);
  const sealed = await loadSealedPromptArtifacts(batchId, action.laneId, action.role);
  if (sealed.inputManifest.inputManifestSha256 !== lane.inputManifestSha256) {
    throw new Error(`Sealed input changed before admission for ${action.role} ${action.laneId}.`);
  }
  if (sealed.artifacts.attachments.length > 1) {
    throw new Error(
      `Batch v2 admits one canonical sealed bundle per attempt; ${action.role} ${action.laneId} has ${sealed.artifacts.attachments.length} attachments.`,
    );
  }
  const bundleBytes = sealed.artifacts.attachments[0]
    ? await fs.readFile(sealed.artifacts.attachments[0].path)
    : undefined;
  const idempotencyKey = batchAttemptIdempotencyKey(
    batchId,
    action.laneId,
    action.role,
    action.attempt,
  );
  const owner = batchOwner(batchId, lane, action.attempt);
  const requestId = `batch-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
  const admission = await admitOracleJob(client, {
    requestId,
    idempotency: { scope: "oracle-batch", key: idempotencyKey },
    owner,
    promptBytes: Buffer.from(sealed.artifacts.composerText, "utf8"),
    bundleBytes,
    bundleMediaType: bundleBytes
      ? batchBundleMediaType(sealed.artifacts.bundled?.format)
      : undefined,
    intentDirectory: path.join(getBatchPaths(batchId).root, "job-intents"),
    lineage: {
      batchId,
      laneId: action.laneId,
      role: action.role,
    },
  });
  const admittedAt = new Date().toISOString();
  await mutateBatchState(batchId, (current) => {
    const update = (entry: BatchLaneState): BatchLaneState => {
      if (entry.id !== action.laneId || entry.role !== action.role) return entry;
      assertAdmissionClaim(entry, action);
      return {
        ...entry,
        status: "running",
        jobId: admission.admission.job.id,
        startedAt: entry.startedAt ?? admittedAt,
        lastError: undefined,
        dispatchReservation: undefined,
        attempts: entry.attempts.map((attempt, index) =>
          index === entry.attempts.length - 1
            ? {
                ...attempt,
                jobId: admission.admission.job.id,
                idempotencyKey,
                phase: "started" as const,
                dispatchStartedAt: admittedAt,
              }
            : attempt,
        ),
      };
    };
    return {
      ...current,
      lanes: current.lanes.map(update),
      ...(current.synthesis ? { synthesis: update(current.synthesis) } : {}),
    };
  });
  return admission.admission.job;
}

async function markAdmissionUnobserved(
  batchId: string,
  action: AdmissionAction,
  reason: unknown,
): Promise<void> {
  await mutateBatchState(batchId, (state) => {
    const update = (lane: BatchLaneState): BatchLaneState => {
      if (lane.id !== action.laneId || lane.role !== action.role) return lane;
      if (lane.dispatchReservation?.token !== action.claimToken) return lane;
      return {
        ...lane,
        status: "recoverable",
        dispatchReservation: undefined,
        lastError: {
          code: "batch-job-admission-unobserved",
          message:
            reason instanceof Error
              ? reason.message
              : String(reason ?? "Admission was not observed."),
          retrySafe: false,
        },
        attempts: lane.attempts.map((attempt, index) =>
          index === lane.attempts.length - 1
            ? { ...attempt, phase: "created" as const, claimedAt: undefined }
            : attempt,
        ),
      };
    };
    return {
      ...state,
      lanes: state.lanes.map(update),
      ...(state.synthesis ? { synthesis: update(state.synthesis) } : {}),
    };
  });
}

async function observeMappedJobs(
  batchId: string,
  client: BatchJobClient,
  options: RunBatchOptions,
): Promise<BatchStateV1> {
  const state = await readBatchState(batchId);
  const jobIds = [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])]
    .filter(
      (lane) =>
        lane.jobId &&
        !lane.acceptedMissing &&
        !["completed", "error", "indeterminate", "abandoned"].includes(lane.status),
    )
    .map((lane) => lane.jobId!);
  await Promise.all(
    [...new Set(jobIds)].map((jobId) =>
      waitForBatchSettled(client, jobId, {
        timeoutMs: options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS,
        pollMs: options.observationPollMs ?? DEFAULT_OBSERVATION_POLL_MS,
      }).catch(() => undefined),
    ),
  );
  let reconciled = await mutateBatchState(batchId, (current) =>
    reconcileBatchState(current, client),
  );
  reconciled = await recoverCompletedEvidence(reconciled, client);
  return reconciled;
}

async function waitForBatchSettled(
  client: Pick<BatchJobClient, "getJob">,
  jobId: string,
  options: { timeoutMs: number; pollMs: number },
): Promise<ClientJob> {
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const job = await client.getJob(jobId);
    if (BATCH_SETTLED_JOB_STATES.has(job.state.kind) || Date.now() >= deadline) return job;
    await delay(options.pollMs);
  }
}

async function prepareOwnerResume(state: BatchStateV1, client: BatchJobClient): Promise<void> {
  for (const lane of [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])]) {
    if (
      lane.acceptedMissing ||
      !lane.jobId ||
      ["completed", "error", "indeterminate", "abandoned"].includes(lane.status)
    ) {
      continue;
    }
    let job: ClientJob;
    try {
      job = await client.getJob(lane.jobId);
    } catch {
      continue;
    }
    if (
      job.state.kind === "failed-unsent" ||
      (job.state.kind === "recoverable" && job.state.basis === "verified-unsent")
    ) {
      if (job.state.kind === "recoverable") {
        await client.abandonBatchJob(
          job.id,
          job.spec.owner,
          "Batch parent opened a safe new attempt",
        );
      }
      await appendNextAttempt(state.batchId, lane);
      continue;
    }
    if (job.state.kind === "recoverable" && job.state.basis === "committed-capture") {
      await client.resumeBatchJob(job.id, job.spec.owner);
    }
  }
}

async function appendNextAttempt(batchId: string, lane: BatchLaneState): Promise<void> {
  await mutateBatchState(batchId, (state) => {
    const update = (entry: BatchLaneState): BatchLaneState => {
      if (entry.id !== lane.id || entry.role !== lane.role || entry.jobId !== lane.jobId)
        return entry;
      const attempt = (entry.attempts.at(-1)?.attempt ?? 0) + 1;
      return {
        ...entry,
        status: "sealed",
        jobId: undefined,
        lastError: undefined,
        dispatchReservation: undefined,
        attempts: [
          ...entry.attempts,
          {
            attempt,
            idempotencyKey: batchAttemptIdempotencyKey(batchId, entry.id, entry.role, attempt),
            createdAt: new Date().toISOString(),
            phase: "created" as const,
          },
        ],
      };
    };
    return {
      ...state,
      lanes: state.lanes.map(update),
      ...(state.synthesis ? { synthesis: update(state.synthesis) } : {}),
    };
  });
}

async function advanceBatch(
  batchId: string,
  client: BatchJobClient,
  options: RunBatchOptions,
  deps: BatchRuntimeDeps,
  depth = 0,
): Promise<BatchRunResult> {
  let state = await mutateBatchState(batchId, (current) => reconcileBatchState(current, client));
  state = await recoverCompletedEvidence(state, client);
  const nonaccepted = state.lanes.filter((lane) => !lane.acceptedMissing);
  const unavailable = nonaccepted.filter((lane) =>
    ["error", "indeterminate", "abandoned"].includes(lane.status),
  );
  const incomplete = nonaccepted.filter((lane) => lane.status !== "completed");
  if (unavailable.length > 0) {
    state = await setParentStatus(batchId, "awaiting-owner");
    return finalizeReport(state);
  }
  if (incomplete.length > 0) {
    state = await setParentStatus(
      batchId,
      state.status === "interrupted" ? "interrupted" : "awaiting-recovery",
    );
    return finalizeReport(state);
  }
  if (!state.barrierClosedAt) {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      barrierClosedAt: current.barrierClosedAt ?? new Date().toISOString(),
      synthesisEligible: true,
    }));
  }
  if (!state.synthesis) {
    state = await setParentStatus(batchId, hasPartialDecision(state) ? "partial" : "completed");
    return finalizeReport(state);
  }
  if (state.synthesis.acceptedMissing || state.synthesis.status === "abandoned") {
    state = await setParentStatus(batchId, "partial");
    return finalizeReport(state);
  }
  if (state.synthesis.status === "completed") {
    state = await setParentStatus(batchId, hasPartialDecision(state) ? "partial" : "completed");
    return finalizeReport(state);
  }
  if (state.synthesis.status === "error" || state.synthesis.status === "indeterminate") {
    state = await setParentStatus(batchId, "awaiting-owner");
    return finalizeReport(state);
  }
  if (state.synthesis.jobId) {
    state = await setParentStatus(batchId, "awaiting-recovery");
    return finalizeReport(state);
  }
  if (depth > 1) {
    state = await setParentStatus(batchId, "awaiting-recovery");
    return finalizeReport(state);
  }
  const sealed = await ensureSynthesisSealed(state, deps);
  if (!sealed) return finalizeReport(await readBatchState(batchId));
  const actions = await prepareAdmissionActions(batchId, "synthesis");
  await admitActions(batchId, actions, client, options);
  await observeMappedJobs(batchId, client, options);
  return advanceBatch(batchId, client, options, deps, depth + 1);
}

async function ensureSynthesisSealed(
  state: BatchStateV1,
  deps: BatchRuntimeDeps,
): Promise<boolean> {
  if (!state.synthesis) return false;
  if (state.synthesis.inputManifestSha256) return true;
  const claimToken = createHash("sha256")
    .update(`${process.pid}\0${state.batchId}\0synthesis-seal\0${Date.now()}\0${Math.random()}`)
    .digest("hex");
  let reserved = false;
  await mutateBatchState(state.batchId, (current) => {
    if (!current.synthesis || current.synthesis.inputManifestSha256 || current.synthesis.jobId) {
      return current;
    }
    if (
      current.synthesis.dispatchReservation &&
      isProcessAlive(current.synthesis.dispatchReservation.pid)
    ) {
      return current;
    }
    reserved = true;
    return {
      ...current,
      status: "synthesizing",
      synthesis: {
        ...current.synthesis,
        status: "sealed",
        dispatchReservation: {
          pid: process.pid,
          token: claimToken,
          reservedAt: new Date().toISOString(),
        },
      },
    };
  });
  if (!reserved) return false;
  try {
    const current = await readBatchState(state.batchId);
    const sealed = await sealSynthesisInput(current, { assemblePrompt: deps.assemblePrompt });
    await mutateBatchState(state.batchId, (latest) => {
      if (latest.synthesis?.dispatchReservation?.token !== claimToken) {
        throw new Error(`Lost synthesis sealing claim for Batch ${state.batchId}.`);
      }
      return {
        ...latest,
        status: "synthesizing",
        synthesis: {
          ...latest.synthesis,
          status: "sealed",
          inputManifestSha256: sealed.inputManifest.inputManifestSha256,
          inputManifestPath: path.join(
            getBatchPaths(state.batchId).inputs,
            "synthesis",
            "input-manifest.json",
          ),
          outputPath: answerOutputPath(state.batchId, latest.synthesis.id, "synthesis"),
          dispatchReservation: undefined,
        },
      };
    });
    return true;
  } catch (error) {
    await mutateBatchState(state.batchId, (current) => ({
      ...current,
      status: "awaiting-owner",
      synthesis: current.synthesis
        ? {
            ...current.synthesis,
            status: "error",
            dispatchReservation: undefined,
            lastError: {
              code:
                error instanceof BatchSynthesisInputTooLargeError
                  ? error.code
                  : "batch-synthesis-sealing-failed",
              message: error instanceof Error ? error.message : String(error),
              retrySafe: false,
            },
          }
        : current.synthesis,
    }));
    return false;
  }
}

async function recoverCompletedEvidence(
  initial: BatchStateV1,
  client: BatchJobClient,
): Promise<BatchStateV1> {
  let state = initial;
  for (const lane of [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])]) {
    if (!lane.jobId || !lane.inputManifestSha256 || !lane.outputPath) continue;
    if (lane.status === "completed" && !lane.outputSha256) {
      try {
        const [job, result] = await Promise.all([
          client.getJob(lane.jobId),
          client.getResult(lane.jobId),
        ]);
        const completed = verifyCompletedResult(lane, job, result);
        const answer = completed.answer;
        await writeAnswerOutput(lane.outputPath, answer);
        const outputSha256 = digest(answer);
        await writeAnswerReceipt(initial.batchId, lane, job, completed.result, {
          status: "completed",
          answerSha256: outputSha256,
          answerBytes: answer.length,
        });
        state = await mutateBatchState(initial.batchId, (current) =>
          updateLane(current, lane, {
            status: "completed",
            outputSha256,
            completedAt: lane.completedAt ?? job.updatedAt ?? new Date().toISOString(),
            lastError: undefined,
          }),
        );
      } catch (error) {
        state = await mutateBatchState(initial.batchId, (current) =>
          updateLane(current, lane, {
            status: "error",
            lastError: {
              code: "batch-answer-output-missing",
              message: error instanceof Error ? error.message : String(error),
              retrySafe: false,
            },
          }),
        );
      }
    } else if (lane.status === "completed" && lane.outputSha256) {
      try {
        await readVerifiedBatchAnswer(initial.batchId, lane);
      } catch (error) {
        state = await mutateBatchState(initial.batchId, (current) =>
          updateLane(current, lane, {
            status: "error",
            lastError: {
              code:
                error instanceof BatchAnswerIntegrityError
                  ? error.code
                  : "batch-answer-integrity-mismatch",
              message: error instanceof Error ? error.message : String(error),
              retrySafe: false,
            },
          }),
        );
      }
    }
  }
  return state;
}

function verifyCompletedResult(
  lane: BatchLaneState,
  job: ClientJob,
  result: ClientJobResult,
): { answer: Buffer; result: Extract<ClientJobResult, { ready: true }> } {
  if (job.id !== lane.jobId || job.state.kind !== "completed") {
    throw new Error(`Batch job ${lane.jobId} is not completed.`);
  }
  if (!result.ready || result.state !== "completed" || result.jobId !== job.id) {
    throw new Error(`Batch job ${job.id} has no completed answer object.`);
  }
  const answer = Buffer.from(result.text, "utf8");
  const answerSha256 = digest(answer);
  if (
    answerSha256 !== result.answer.sha256 ||
    result.answer.sha256 !== job.state.answer.sha256 ||
    result.answer.sizeBytes !== answer.length ||
    job.state.answer.sizeBytes !== answer.length
  ) {
    throw new Error(`Batch job ${job.id} answer object identity does not match its bytes.`);
  }
  return { answer, result };
}

async function writeAnswerOutput(outputPath: string, answer: Buffer): Promise<void> {
  const existing = await fs.readFile(outputPath).catch(() => null);
  if (existing) {
    if (!existing.equals(answer)) {
      throw new BatchAnswerIntegrityError(
        path.basename(path.dirname(outputPath)),
        `Existing Batch answer differs from the completed job object at ${outputPath}.`,
      );
    }
    return;
  }
  await writeOwnerFileAtomic(outputPath, answer);
}

async function writeAnswerReceipt(
  batchId: string,
  lane: BatchLaneState,
  job: ClientJob,
  result: Extract<ClientJobResult, { ready: true }>,
  outcome: Pick<BatchAnswerReceiptV1, "status" | "answerSha256" | "answerBytes" | "error">,
): Promise<void> {
  if (!lane.inputManifestSha256) throw new Error(`Lane ${lane.id} has no sealed input identity.`);
  const conversationId =
    job.state.kind === "completed" ? job.state.submission.conversationId : undefined;
  const receipt: BatchAnswerReceiptV1 = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId,
    laneId: lane.id,
    role: lane.role,
    jobId: job.id,
    status: outcome.status,
    capturedAt: new Date().toISOString(),
    inputManifestSha256: lane.inputManifestSha256,
    answerSha256: outcome.answerSha256,
    answerBytes: outcome.answerBytes,
    answerObjectSha256: result.answer.sha256,
    conversationId,
    error: outcome.error,
  };
  const receiptPath = getAnswerReceiptPath(batchId, lane.id, lane.role);
  const existing = await fs.readFile(receiptPath, "utf8").catch(() => null);
  if (existing) {
    const parsed = JSON.parse(existing) as BatchAnswerReceiptV1;
    if (
      parsed.batchId !== receipt.batchId ||
      parsed.laneId !== receipt.laneId ||
      parsed.role !== receipt.role ||
      parsed.jobId !== receipt.jobId ||
      parsed.inputManifestSha256 !== receipt.inputManifestSha256 ||
      parsed.status !== receipt.status ||
      parsed.answerSha256 !== receipt.answerSha256 ||
      parsed.answerBytes !== receipt.answerBytes ||
      parsed.answerObjectSha256 !== receipt.answerObjectSha256
    ) {
      throw new BatchAnswerIntegrityError(
        lane.id,
        `Existing answer receipt identity differs for lane ${lane.id}; refusing to overwrite it.`,
      );
    }
    return;
  }
  await writeJsonAtomic(receiptPath, receipt);
}

async function recordAllowPartialDecision(state: BatchStateV1): Promise<BatchStateV1> {
  const unaccepted = state.lanes.filter(
    (lane) => lane.status !== "completed" && !lane.acceptedMissing,
  );
  if (unaccepted.length > 0) {
    throw new Error(
      `Partial synthesis requires an explicit accept-missing decision for each unavailable lane: ${unaccepted.map((lane) => `${lane.id}=${lane.status}`).join(", ")}. Use oracle batch accept-missing first.`,
    );
  }
  const missing = state.lanes.filter((lane) => lane.status !== "completed");
  if (
    missing.length === 0 ||
    state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
  ) {
    return state;
  }
  return mutateBatchState(state.batchId, (current) => ({
    ...current,
    ownerDecisions: [
      ...(current.ownerDecisions ?? []),
      {
        type: "allow-partial" as const,
        decidedAt: new Date().toISOString(),
        missingLaneIds: missing.map((lane) => lane.id),
      },
    ],
  }));
}

async function closeOwnedJobForMissing(
  client: BatchJobClient,
  state: BatchStateV1,
  lane: BatchLaneState,
  reason: string,
): Promise<void> {
  if (!lane.jobId) return;
  const job = await client.getJob(lane.jobId);
  const expectedOwner = batchOwner(
    state.batchId,
    lane,
    lane.attempts.find((attempt) => attempt.jobId === lane.jobId)?.attempt ??
      lane.attempts.at(-1)?.attempt ??
      1,
  );
  if (JSON.stringify(job.spec.owner) !== JSON.stringify(expectedOwner)) {
    throw new Error(`Batch job ${job.id} owner identity does not match parent lane ${lane.id}.`);
  }
  if (job.state.kind === "completed") throw new Error(`Lane ${lane.id} already completed.`);
  if (["failed-unsent", "canceled-unsent", "abandoned"].includes(job.state.kind)) return;
  if (["queued", "committed", "capturing", "recoverable", "ambiguous"].includes(job.state.kind)) {
    await client.abandonBatchJob(job.id, expectedOwner, reason);
    return;
  }
  throw new Error(
    `Batch job ${job.id} is still ${job.state.kind}; wait for a durable recoverable or terminal state before accept-missing.`,
  );
}

function abandonLane(
  lane: BatchLaneState,
  decidedAt: string,
  reason: string,
  code: string,
): BatchLaneState {
  return {
    ...lane,
    status: "abandoned",
    acceptedMissing: true,
    abandonedAt: decidedAt,
    dispatchReservation: undefined,
    attempts: lane.attempts.map((attempt, index) =>
      index === lane.attempts.length - 1 ? { ...attempt, phase: "abandoned" as const } : attempt,
    ),
    lastError: { code, message: reason, retrySafe: false },
  };
}

async function recoverFirstStageSeal(state: BatchStateV1): Promise<BatchStateV1> {
  try {
    const paths = getBatchPaths(state.batchId);
    const receipt = JSON.parse(
      await fs.readFile(paths.firstStageSeal, "utf8"),
    ) as BatchFirstStageSealV1;
    if (receipt.schemaVersion !== BATCH_SCHEMA_VERSION || receipt.batchId !== state.batchId) {
      throw new Error("first-stage seal receipt identity mismatch");
    }
    const sealedById = new Map(receipt.lanes.map((lane) => [lane.id, lane] as const));
    for (const lane of state.lanes) {
      const sealed = await loadSealedPromptArtifacts(state.batchId, lane.id);
      if (
        sealed.inputManifest.inputManifestSha256 !== sealedById.get(lane.id)?.inputManifestSha256
      ) {
        throw new Error(`sealed input identity mismatch for lane ${lane.id}`);
      }
    }
    if (receipt.sourceSnapshotManifestSha256 !== state.sourceSnapshotManifestSha256) {
      throw new Error("first-stage source snapshot identity mismatch");
    }
    return mutateBatchState(state.batchId, (current) => ({
      ...current,
      status: "sealed",
      lanes: current.lanes.map((lane) => ({
        ...lane,
        status: "sealed",
        inputManifestSha256: sealedById.get(lane.id)!.inputManifestSha256,
        inputManifestPath: path.join(paths.inputs, "lanes", lane.id, "input-manifest.json"),
        outputPath: answerOutputPath(state.batchId, lane.id, "lane"),
      })),
    }));
  } catch (error) {
    return mutateBatchState(state.batchId, (current) => ({
      ...current,
      status: "error",
      lastError: {
        code: "batch-first-stage-seal-incomplete",
        message: `The process stopped before a complete first-stage seal could be verified: ${error instanceof Error ? error.message : String(error)}. Start a new batch from the manifest; no job was admitted.`,
      },
    }));
  }
}

async function refreshAdmittedSourceDrift(state: BatchStateV1): Promise<BatchStateV1> {
  const admittedSourceDrift = await detectAdmittedSourceDrift({
    cwd: state.cwd,
    sourceManifestPath: getBatchPaths(state.batchId).sourceManifestIdentity,
  });
  return { ...state, admittedSourceDrift, workspaceDrift: undefined };
}

async function finalizeReport(state: BatchStateV1): Promise<BatchRunResult> {
  const manifest = await readNormalizedBatchManifest(state.batchId);
  const report = await renderBatch(manifest, state);
  const reportPath = getBatchPaths(state.batchId).report;
  await writeOwnerFileAtomic(reportPath, report);
  return { state, reportPath };
}

function updateLane(
  state: BatchStateV1,
  lane: BatchLaneState,
  updates: Partial<BatchLaneState>,
): BatchStateV1 {
  const apply = (entry: BatchLaneState): BatchLaneState =>
    entry.id === lane.id && entry.role === lane.role ? { ...entry, ...updates } : entry;
  return {
    ...state,
    lanes: state.lanes.map(apply),
    ...(state.synthesis ? { synthesis: apply(state.synthesis) } : {}),
  };
}

async function setParentStatus(
  batchId: string,
  status: BatchStateV1["status"],
): Promise<BatchStateV1> {
  return mutateBatchState(batchId, (state) => ({ ...state, status }));
}

function findLane(state: BatchStateV1, laneId: string, role: "lane" | "synthesis"): BatchLaneState {
  const lane = role === "lane" ? state.lanes.find((entry) => entry.id === laneId) : state.synthesis;
  if (!lane || lane.id !== laneId || lane.role !== role) {
    throw new Error(`Missing Batch ${role} mapping for ${laneId}.`);
  }
  return lane;
}

function assertAdmissionClaim(lane: BatchLaneState, action: AdmissionAction): void {
  if (
    lane.dispatchReservation?.pid !== process.pid ||
    lane.dispatchReservation.token !== action.claimToken ||
    lane.attempts.at(-1)?.attempt !== action.attempt
  ) {
    throw new Error(`Lost Batch admission claim for ${action.role} ${action.laneId}.`);
  }
}

function batchOwner(batchId: string, lane: BatchLaneState, attempt: number): JobSpec["owner"] {
  return lane.role === "lane"
    ? { kind: "batch-lane", batchId, laneId: lane.id, attempt }
    : { kind: "batch-synthesis", batchId, attempt };
}

function openBatchClient(deps: BatchRuntimeDeps): {
  client: BatchJobClient;
  close: () => void;
} {
  if (deps.client) return { client: deps.client, close: () => undefined };
  const client = new OracleClient({ socketPath: resolveBrokerPaths().socketPath });
  return { client, close: () => client.close() };
}

function resolveEffectiveCaps(
  loaded: LoadedBatchManifest,
  config: UserConfig,
  cliMaxParallel?: number,
): { maxParallel: number; maxChildSessions: number } {
  const localParallel = resolvePositiveInt(config.batch?.maxParallel, DEFAULT_BATCH_MAX_PARALLEL);
  const manifestParallel = resolvePositiveInt(
    loaded.manifest.policy?.maxParallel,
    DEFAULT_BATCH_MAX_PARALLEL,
  );
  const requested =
    cliMaxParallel === undefined ? Number.POSITIVE_INFINITY : resolvePositiveInt(cliMaxParallel, 1);
  const maxParallel = Math.min(
    MAX_BATCH_ADMISSION_PARALLEL,
    localParallel,
    manifestParallel,
    requested,
  );
  const localChildren = resolvePositiveInt(
    config.batch?.maxChildSessions,
    DEFAULT_BATCH_MAX_CHILD_SESSIONS,
  );
  const manifestChildren = resolvePositiveInt(
    loaded.manifest.policy?.maxChildSessions,
    localChildren,
  );
  return { maxParallel, maxChildSessions: Math.min(localChildren, manifestChildren) };
}

function assertNoLegacyExecutionState(state: BatchStateV1): void {
  const legacy = [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])].filter(
    (lane) => lane.sessionId && !lane.jobId,
  );
  if (legacy.length === 0) return;
  throw new Error(
    `Batch ${state.batchId} was created by the pre-R9 child-session runtime (${legacy.map((lane) => lane.id).join(", ")}). Its state remains readable and protected, but the v2 Batch parent will not relaunch a legacy browser child.`,
  );
}

function assertBatchEnabled(config: UserConfig): void {
  if (config.batch?.enabled === false) {
    throw new Error("Batch Oracle is disabled by the local owner config (batch.enabled=false). ");
  }
}

function requireOwnerReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error("accept-missing requires a non-empty owner reason.");
  return normalized;
}

function hasPartialDecision(state: BatchStateV1): boolean {
  return Boolean(state.ownerDecisions?.some((decision) => decision.type === "allow-partial"));
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function answerOutputPath(batchId: string, laneId: string, role: "lane" | "synthesis"): string {
  return role === "lane"
    ? path.join(getBatchPaths(batchId).outputs, "lanes", laneId, "answer.md")
    : path.join(getBatchPaths(batchId).outputs, "synthesis", "answer.md");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function batchBundleMediaType(format: "auto" | "text" | "zip" | undefined): string {
  return format === "zip" ? "application/zip" : "text/plain";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
