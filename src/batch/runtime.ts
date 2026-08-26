import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserPromptArtifacts } from "../browser/prompt.js";
import { ensureSessionArtifacts } from "../browser/sessionRunner.js";
import { resumeBrowserSession } from "../browser/reattach.js";
import type { BrowserLogger } from "../browser/types.js";
import { performSessionRun } from "../cli/sessionRunner.js";
import { loadUserConfig, type UserConfig } from "../config.js";
import type { RunOracleOptions } from "../oracle/types.js";
import { getCliVersion } from "../version.js";
import {
  sessionStore,
  type BrowserSessionConfig,
  type SessionMetadata,
  type SessionStore,
} from "../sessionStore.js";
import { buildCanonicalBatchBrowserConfig } from "./browserConfig.js";
import {
  BatchAnswerIntegrityError,
  getAnswerReceiptPath,
  readVerifiedBatchAnswer,
} from "./answers.js";
import { detectAdmittedSourceDrift, loadBatchManifest, snapshotBatchSources } from "./manifest.js";
import { classifyParentStatus, deriveLaneSessionState, reconcileBatchState } from "./reconcile.js";
import { buildBatchStatusProjection, renderBatch } from "./render.js";
import { runBoundedScheduler, type BatchScheduleResult } from "./scheduler.js";
import { loadSealedPromptArtifacts, sealFirstStageInputs } from "./seal.js";
import {
  createBatchId,
  ensureOwnerDir,
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
  BatchInputManifestV1,
  BatchLaneState,
  BatchStateV1,
  LoadedBatchManifest,
  SealedBrowserPromptArtifacts,
} from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

const DEFAULT_BATCH_MAX_PARALLEL = 3;
const DEFAULT_BATCH_MAX_CHILD_SESSIONS = 5;

export interface BatchRuntimeDeps {
  store?: SessionStore;
  dispatchChild?: (context: BatchChildExecutionContext) => Promise<void>;
  reattachChild?: (context: BatchChildExecutionContext) => Promise<void>;
  buildBrowserConfig?: (config: UserConfig) => Promise<BrowserSessionConfig>;
  assemblePrompt?: (
    options: RunOracleOptions,
    deps?: { cwd?: string },
  ) => Promise<BrowserPromptArtifacts>;
}

export interface BatchChildExecutionContext {
  batchId: string;
  laneId: string;
  role: "lane" | "synthesis";
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  artifacts: SealedBrowserPromptArtifacts;
  inputManifest: BatchInputManifestV1;
  outputPath: string;
  store: SessionStore;
}

export interface RunBatchOptions {
  cwd?: string;
  maxParallel?: number;
  log?: (message: string) => void;
}

export interface BatchRunResult {
  state: BatchStateV1;
  reportPath: string;
}

interface PreparedAction {
  laneId: string;
  role: "lane" | "synthesis";
  kind: "dispatch" | "reattach";
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
  const browserConfig = await (deps.buildBrowserConfig ?? buildCanonicalBatchBrowserConfig)(config);
  const caps = resolveEffectiveCaps(loaded, config, browserConfig, options.maxParallel);
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
        };
      }),
    };
    await writeBatchState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = {
      ...state,
      status: "error",
      lastError: {
        code: "batch-input-sealing-failed",
        message,
      },
    };
    await writeBatchState(state);
    throw new Error(`Batch ${batchId} failed before dispatch: ${message}`);
  }

  let initialActions: PreparedAction[] = [];
  try {
    const claimed = await createFirstStageSessions(
      state,
      loaded,
      browserConfig,
      deps.store ?? sessionStore,
    );
    state = claimed.state;
    initialActions = claimed.actions;
  } catch (error) {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: "error",
      lastError: {
        code: "batch-child-session-creation-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    throw error;
  }
  await executePreparedActions(batchId, initialActions, browserConfig, options, deps);
  return advanceAfterFirstStage(batchId, browserConfig, options, deps);
}

export async function resumeBatch(
  batchId: string,
  options: RunBatchOptions & { allowPartial?: boolean } = {},
  deps: BatchRuntimeDeps = {},
): Promise<BatchRunResult> {
  const log = options.log ?? console.log;
  let state = await readBatchState(batchId);
  const config = (await loadUserConfig({ cwd: state.cwd })).config;
  assertBatchEnabled(config);
  const store = deps.store ?? sessionStore;
  if (["completed", "partial"].includes(state.status)) {
    return finalizeReport(state);
  }
  if (state.status === "preparing") {
    state = await recoverFirstStageSeal(state);
  }
  if (
    state.status === "error" &&
    state.lanes.every((lane) => !lane.sessionId) &&
    ["batch-input-sealing-failed", "batch-first-stage-seal-incomplete"].includes(
      state.lastError?.code ?? "",
    )
  ) {
    return finalizeReport(state);
  }
  const browserConfig = await (deps.buildBrowserConfig ?? buildCanonicalBatchBrowserConfig)(config);
  state = await mutateBatchState(batchId, async (current) =>
    refreshAdmittedSourceDrift(await reconcileBatchState(current, store)),
  );

  if (options.allowPartial) {
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
      missing.length > 0 &&
      !state.ownerDecisions?.some((decision) => decision.type === "allow-partial")
    ) {
      state = await mutateBatchState(batchId, (current) => ({
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
  }

  const prepared = await prepareResumeActions(state, browserConfig, store);
  if (prepared.length > 0) {
    log(`Resuming ${prepared.length} batch lane${prepared.length === 1 ? "" : "s"}.`);
    await executePreparedActions(batchId, prepared, browserConfig, options, deps);
  }
  return advanceAfterFirstStage(batchId, browserConfig, options, deps);
}

export async function acceptMissingBatchLane(
  batchId: string,
  laneId: string,
  reason: string,
): Promise<BatchStateV1> {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error("accept-missing requires a non-empty owner reason.");
  return mutateBatchState(batchId, (state) => {
    const lane = state.lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Unknown batch lane: ${laneId}`);
    if (lane.status === "completed") throw new Error(`Lane ${laneId} already completed.`);
    if (lane.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid)) {
      throw new Error(`Lane ${laneId} is actively claimed; stop or reconcile it before closure.`);
    }
    if (lane.acceptedMissing) return state;
    const decidedAt = new Date().toISOString();
    return {
      ...state,
      status: "awaiting-owner",
      lanes: state.lanes.map((entry) =>
        entry.id === laneId
          ? {
              ...entry,
              status: "abandoned",
              acceptedMissing: true,
              abandonedAt: decidedAt,
              dispatchReservation: undefined,
              attempts: entry.attempts.map((attempt, index) =>
                index === entry.attempts.length - 1
                  ? { ...attempt, phase: "abandoned" as const }
                  : attempt,
              ),
              lastError: {
                code: "batch-lane-accepted-missing",
                message: normalizedReason,
                retrySafe: false,
              },
            }
          : entry,
      ),
      ownerDecisions: [
        ...(state.ownerDecisions ?? []),
        {
          type: "accept-missing" as const,
          decidedAt,
          laneId,
          reason: normalizedReason,
          sessionId: lane.sessionId,
          missingLaneIds: [laneId],
        },
      ],
    };
  });
}

export async function getBatchStatus(batchId: string, store: SessionStore = sessionStore) {
  const state = await mutateBatchState(batchId, async (current) => {
    const reconciled = await refreshAdmittedSourceDrift(await reconcileBatchState(current, store));
    return { ...reconciled, status: classifyParentStatus(reconciled) };
  });
  return { state, projection: buildBatchStatusProjection(state) };
}

export async function listRecentBatches(hours = 72): Promise<BatchStateV1[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
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

async function createFirstStageSessions(
  state: BatchStateV1,
  loaded: LoadedBatchManifest,
  browserConfig: BrowserSessionConfig,
  store: SessionStore,
): Promise<{ state: BatchStateV1; actions: PreparedAction[] }> {
  const actions: PreparedAction[] = [];
  const nextState = await mutateBatchState(state.batchId, async (current) => {
    let next = current;
    for (const laneSpec of loaded.manifest.lanes) {
      const lane = next.lanes.find((entry) => entry.id === laneSpec.id)!;
      if (lane.sessionId) continue;
      const sealed = await loadSealedPromptArtifacts(state.batchId, lane.id);
      const created = await createChildSession({
        state: next,
        lane,
        role: "lane",
        browserConfig,
        sealed,
        store,
      });
      const claimToken = randomUUID();
      next = {
        ...next,
        lanes: next.lanes.map((entry) =>
          entry.id === lane.id
            ? {
                ...entry,
                status: "claimed",
                sessionId: created.id,
                outputPath: childOutputPath(next.batchId, lane.id, "lane"),
                attempts: [
                  ...entry.attempts,
                  {
                    attempt: 1,
                    sessionId: created.id,
                    createdAt: created.createdAt,
                    phase: "claimed" as const,
                    claimedAt: new Date().toISOString(),
                  },
                ],
                dispatchReservation: {
                  pid: process.pid,
                  token: claimToken,
                  reservedAt: new Date().toISOString(),
                },
              }
            : entry,
        ),
      };
      actions.push({ laneId: lane.id, role: "lane", kind: "dispatch", claimToken });
      await writeBatchState(next);
    }
    return { ...next, status: "running" };
  });
  return { state: nextState, actions };
}

async function createChildSession(options: {
  state: BatchStateV1;
  lane: BatchLaneState;
  role: "lane" | "synthesis";
  browserConfig: BrowserSessionConfig;
  sealed: { artifacts: SealedBrowserPromptArtifacts; inputManifest: BatchInputManifestV1 };
  store: SessionStore;
  attempt?: number;
}): Promise<SessionMetadata> {
  const outputPath = childOutputPath(options.state.batchId, options.lane.id, options.role);
  await ensureOwnerDir(path.dirname(outputPath));
  const runOptions = buildChildRunOptions(
    options.state,
    options.lane.id,
    options.sealed.artifacts,
    outputPath,
  );
  const created = await options.store.createSession(
    {
      ...runOptions,
      mode: "browser",
      browserConfig: options.browserConfig,
      waitPreference: true,
    },
    options.state.cwd,
    undefined,
    `${options.state.slug}-${options.lane.id}`,
  );
  return options.store.updateSession(created.id, {
    batch: {
      batchId: options.state.batchId,
      laneId: options.lane.id,
      role: options.role,
      attempt: options.attempt ?? 1,
      inputManifestSha256: options.sealed.inputManifest.inputManifestSha256,
    },
  });
}

async function executePreparedActions(
  batchId: string,
  actions: PreparedAction[],
  browserConfig: BrowserSessionConfig,
  options: RunBatchOptions,
  deps: BatchRuntimeDeps,
): Promise<void> {
  const log = options.log ?? console.log;
  const store = deps.store ?? sessionStore;
  const state = await readBatchState(batchId);
  let pausePending = false;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    pausePending = true;
  };
  process.once("SIGINT", onInterrupt);
  try {
    await runBoundedScheduler(actions, {
      maxParallel: state.effectiveMaxParallel,
      shouldStart: () => !pausePending,
      onStart: async (action) => {
        await markActionStarted(batchId, action);
        log(`Dispatching ${action.role} ${action.laneId}...`);
      },
      worker: async (action) => {
        const context = await buildChildExecutionContext(batchId, action, browserConfig, store);
        if (action.kind === "reattach") {
          await (deps.reattachChild ?? defaultReattachChild)(context);
        } else {
          await (deps.dispatchChild ?? defaultDispatchChild)(context);
        }
      },
      onSettled: async (action, result) => {
        if (result.status === "skipped") {
          await clearReservation(batchId, action);
          return;
        }
        const derived = await persistChildOutcome(batchId, action, store, result);
        if (derived.lastError?.retrySafe) pausePending = true;
        log(`${action.role} ${action.laneId}: ${derived.status}`);
      },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  if (interrupted) {
    await mutateBatchState(batchId, (current) => ({ ...current, status: "interrupted" }));
  }
}

async function buildChildExecutionContext(
  batchId: string,
  action: PreparedAction,
  browserConfig: BrowserSessionConfig,
  store: SessionStore,
): Promise<BatchChildExecutionContext> {
  const state = await readBatchState(batchId);
  const lane =
    action.role === "lane"
      ? state.lanes.find((entry) => entry.id === action.laneId)
      : state.synthesis;
  if (!lane?.sessionId) throw new Error(`Missing child session for ${action.laneId}.`);
  if (lane.dispatchReservation?.token !== action.claimToken) {
    throw new Error(`Lost child execution claim for ${action.role} ${action.laneId}.`);
  }
  const sessionMeta = await store.readSession(lane.sessionId);
  if (!sessionMeta) throw new Error(`Missing child session metadata: ${lane.sessionId}`);
  const sealed = await loadSealedPromptArtifacts(batchId, action.laneId, action.role);
  const outputPath = lane.outputPath ?? childOutputPath(batchId, action.laneId, action.role);
  return {
    batchId,
    laneId: action.laneId,
    role: action.role,
    sessionMeta,
    runOptions: buildChildRunOptions(state, action.laneId, sealed.artifacts, outputPath),
    browserConfig,
    artifacts: sealed.artifacts,
    inputManifest: sealed.inputManifest,
    outputPath,
    store,
  };
}

async function defaultDispatchChild(context: BatchChildExecutionContext): Promise<void> {
  const writer = context.store.createLogWriter(context.sessionMeta.id);
  try {
    await performSessionRun({
      sessionMeta: context.sessionMeta,
      runOptions: context.runOptions,
      mode: "browser",
      browserConfig: context.browserConfig,
      cwd: context.sessionMeta.cwd ?? process.cwd(),
      log: writer.logLine,
      write: writer.writeChunk,
      version: getCliVersion(),
      muteStdout: true,
      browserDeps: {
        assemblePrompt: async () => context.artifacts as BrowserPromptArtifacts,
      },
    });
  } finally {
    writer.stream.end();
  }
}

async function defaultReattachChild(context: BatchChildExecutionContext): Promise<void> {
  const runtime = context.sessionMeta.browser?.runtime;
  if (!runtime)
    throw new Error(`Session ${context.sessionMeta.id} has no browser runtime to reattach.`);
  const writer = context.store.createLogWriter(context.sessionMeta.id);
  const logger = writer.logLine as BrowserLogger;
  logger.verbose = Boolean(context.runOptions.verbose);
  logger.sessionLog = writer.logLine;
  try {
    const result = await resumeBrowserSession(runtime, context.browserConfig, logger, {
      promptPreview: context.sessionMeta.promptPreview,
      sessionId: context.sessionMeta.id,
      persistRuntime: async (nextRuntime) => {
        await context.store.updateSession(context.sessionMeta.id, {
          status: "running",
          browser: {
            ...context.sessionMeta.browser,
            config: context.browserConfig,
            runtime: nextRuntime,
          },
        });
      },
    });
    await writeOwnerFileAtomic(context.outputPath, result.answerMarkdown || result.answerText);
    const artifacts = await ensureSessionArtifacts({
      sessionId: context.sessionMeta.id,
      prompt: context.artifacts.composerText,
      answerMarkdown: result.answerMarkdown || result.answerText,
      conversationUrl: result.runtime?.tabUrl,
      browserConfig: context.browserConfig,
      existingArtifacts: context.sessionMeta.artifacts,
      logger,
    });
    await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await context.store.updateSession(context.sessionMeta.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      errorMessage: undefined,
      error: undefined,
      browser: {
        ...context.sessionMeta.browser,
        config: context.browserConfig,
        runtime: result.runtime,
      },
      artifacts,
    });
  } finally {
    writer.stream.end();
  }
}

async function persistChildOutcome(
  batchId: string,
  action: PreparedAction,
  store: SessionStore,
  scheduleResult: BatchScheduleResult<void>,
): Promise<ReturnType<typeof deriveLaneSessionState>> {
  const state = await readBatchState(batchId);
  const lane =
    action.role === "lane"
      ? state.lanes.find((entry) => entry.id === action.laneId)
      : state.synthesis;
  if (!lane?.sessionId) throw new Error(`Missing child mapping for ${action.laneId}.`);
  const metadata = await store.readSession(lane.sessionId);
  let derived = deriveLaneSessionState(metadata, lane, {
    actionSettled: scheduleResult.status === "rejected",
  });
  if (scheduleResult.status === "rejected" && derived.status === "session-created") {
    derived = {
      status: "error",
      clearReservation: true,
      lastError: {
        code: "batch-child-execution-failed",
        message:
          scheduleResult.reason instanceof Error
            ? scheduleResult.reason.message
            : String(scheduleResult.reason),
        retrySafe: false,
      },
    };
  }
  let answerIdentity: { sha256: string; bytes: number } | undefined;
  if (derived.status === "completed" && metadata) {
    try {
      const answer = await ensureAnswerOutput(metadata, lane.outputPath!);
      answerIdentity = {
        sha256: createHash("sha256").update(answer).digest("hex"),
        bytes: answer.length,
      };
      await writeAnswerReceipt(batchId, lane, metadata, {
        status: "completed",
        answerSha256: answerIdentity.sha256,
        answerBytes: answerIdentity.bytes,
      });
    } catch (error) {
      derived = {
        status: "error",
        clearReservation: true,
        lastError: {
          code: "batch-answer-output-missing",
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false,
        },
      };
    }
  }
  await mutateBatchState(batchId, (current) => {
    const update = (entry: BatchLaneState): BatchLaneState => {
      if (entry.id !== action.laneId || entry.role !== action.role) return entry;
      if (entry.dispatchReservation?.token !== action.claimToken) {
        throw new Error(`Lost settled action claim for ${action.role} ${action.laneId}.`);
      }
      return {
        ...entry,
        status: derived.status,
        dispatchReservation: undefined,
        ...(derived.lastError ? { lastError: derived.lastError } : {}),
        ...(derived.status === "completed"
          ? {
              completedAt: metadata?.completedAt ?? new Date().toISOString(),
              outputSha256: answerIdentity?.sha256,
              attempts: completeCurrentAttempt(entry.attempts, metadata?.completedAt),
            }
          : {
              attempts: failCurrentAttempt(entry.attempts),
            }),
      };
    };
    return {
      ...current,
      lanes: current.lanes.map(update),
      ...(current.synthesis ? { synthesis: update(current.synthesis) } : {}),
    };
  });
  return derived;
}

async function prepareResumeActions(
  initial: BatchStateV1,
  browserConfig: BrowserSessionConfig,
  store: SessionStore,
): Promise<PreparedAction[]> {
  const actions: PreparedAction[] = [];
  await mutateBatchState(initial.batchId, async (state) => {
    let next = await reconcileBatchState(state, store);
    for (const lane of next.lanes) {
      if (
        lane.acceptedMissing ||
        ["completed", "error", "indeterminate", "abandoned"].includes(lane.status)
      )
        continue;
      if (lane.dispatchReservation && isProcessAlive(lane.dispatchReservation.pid)) continue;
      if (!lane.sessionId) {
        const claimToken = randomUUID();
        const sealed = await loadSealedPromptArtifacts(state.batchId, lane.id);
        const created = await createChildSession({
          state: next,
          lane,
          role: "lane",
          browserConfig,
          sealed,
          store,
          attempt: 1,
        });
        next = {
          ...next,
          lanes: next.lanes.map((entry) =>
            entry.id === lane.id
              ? {
                  ...entry,
                  status: "claimed",
                  sessionId: created.id,
                  outputPath: childOutputPath(next.batchId, lane.id, "lane"),
                  attempts: [
                    {
                      attempt: 1,
                      sessionId: created.id,
                      createdAt: created.createdAt,
                      phase: "claimed" as const,
                      claimedAt: new Date().toISOString(),
                    },
                  ],
                  dispatchReservation: {
                    pid: process.pid,
                    token: claimToken,
                    reservedAt: new Date().toISOString(),
                  },
                }
              : entry,
          ),
        };
        actions.push({ laneId: lane.id, role: "lane", kind: "dispatch", claimToken });
        continue;
      }
      const metadata = lane.sessionId ? await store.readSession(lane.sessionId) : null;
      if (lane.lastError?.retrySafe && metadata?.status === "error") {
        const claimToken = randomUUID();
        const sealed = await loadSealedPromptArtifacts(state.batchId, lane.id);
        const attempt = (lane.attempts.at(-1)?.attempt ?? 0) + 1;
        const created = await createChildSession({
          state: next,
          lane,
          role: "lane",
          browserConfig,
          sealed,
          store,
          attempt,
        });
        next = {
          ...next,
          lanes: next.lanes.map((entry) =>
            entry.id === lane.id
              ? {
                  ...entry,
                  status: "claimed",
                  sessionId: created.id,
                  lastError: undefined,
                  attempts: [
                    ...entry.attempts,
                    {
                      attempt,
                      sessionId: created.id,
                      createdAt: created.createdAt,
                      phase: "claimed" as const,
                      claimedAt: new Date().toISOString(),
                    },
                  ],
                  dispatchReservation: {
                    pid: process.pid,
                    token: claimToken,
                    reservedAt: new Date().toISOString(),
                  },
                }
              : entry,
          ),
        };
        actions.push({ laneId: lane.id, role: "lane", kind: "dispatch", claimToken });
        continue;
      }
      const kind = metadata?.browser?.runtime ? "reattach" : "dispatch";
      const claimToken = randomUUID();
      next = {
        ...next,
        lanes: next.lanes.map((entry) =>
          entry.id === lane.id
            ? {
                ...entry,
                status: "claimed",
                dispatchReservation: {
                  pid: process.pid,
                  token: claimToken,
                  reservedAt: new Date().toISOString(),
                },
              }
            : entry,
        ),
      };
      actions.push({ laneId: lane.id, role: "lane", kind, claimToken });
    }
    const synthesis = next.synthesis;
    if (
      next.barrierClosedAt &&
      synthesis &&
      synthesis.status !== "completed" &&
      synthesis.status !== "error" &&
      (!synthesis.dispatchReservation || !isProcessAlive(synthesis.dispatchReservation.pid))
    ) {
      const metadata = synthesis.sessionId ? await store.readSession(synthesis.sessionId) : null;
      if (synthesis.lastError?.retrySafe && metadata?.status === "error") {
        const claimToken = randomUUID();
        const sealed = await loadSealedPromptArtifacts(state.batchId, synthesis.id, "synthesis");
        const attempt = (synthesis.attempts.at(-1)?.attempt ?? 0) + 1;
        const created = await createChildSession({
          state: next,
          lane: synthesis,
          role: "synthesis",
          browserConfig,
          sealed,
          store,
          attempt,
        });
        next = {
          ...next,
          status: "synthesizing",
          synthesis: {
            ...synthesis,
            status: "claimed",
            sessionId: created.id,
            lastError: undefined,
            attempts: [
              ...synthesis.attempts,
              {
                attempt,
                sessionId: created.id,
                createdAt: created.createdAt,
                phase: "claimed" as const,
                claimedAt: new Date().toISOString(),
              },
            ],
            dispatchReservation: {
              pid: process.pid,
              token: claimToken,
              reservedAt: new Date().toISOString(),
            },
          },
        };
        actions.push({
          laneId: synthesis.id,
          role: "synthesis",
          kind: "dispatch",
          claimToken,
        });
      } else if (metadata) {
        const claimToken = randomUUID();
        next = {
          ...next,
          status: "synthesizing",
          synthesis: {
            ...synthesis,
            status: "claimed",
            dispatchReservation: {
              pid: process.pid,
              token: claimToken,
              reservedAt: new Date().toISOString(),
            },
          },
        };
        actions.push({
          laneId: synthesis.id,
          role: "synthesis",
          kind: metadata.browser?.runtime ? "reattach" : "dispatch",
          claimToken,
        });
      }
    }
    return next;
  });
  return actions;
}

async function advanceAfterFirstStage(
  batchId: string,
  browserConfig: BrowserSessionConfig,
  options: RunBatchOptions,
  deps: BatchRuntimeDeps,
): Promise<BatchRunResult> {
  const store = deps.store ?? sessionStore;
  let state = await mutateBatchState(batchId, (current) => reconcileBatchState(current, store));
  state = await recoverCompletedEvidence(state, store);
  const nonaccepted = state.lanes.filter((lane) => !lane.acceptedMissing);
  const allCompleted = nonaccepted.every((lane) => lane.status === "completed");
  const terminalErrors = nonaccepted.filter((lane) =>
    ["error", "indeterminate"].includes(lane.status),
  );
  const recoverable = nonaccepted.filter(
    (lane) => !["completed", "error", "indeterminate"].includes(lane.status),
  );
  if (recoverable.length > 0) {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: current.status === "interrupted" ? "interrupted" : "awaiting-recovery",
    }));
    return finalizeReport(state);
  }
  if (terminalErrors.length > 0) {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: "awaiting-owner",
    }));
    return finalizeReport(state);
  }
  if (!allCompleted) {
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
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: current.ownerDecisions?.some((decision) => decision.type === "allow-partial")
        ? "partial"
        : "completed",
    }));
    return finalizeReport(state);
  }
  if (state.synthesis.status === "completed") {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: classifyParentStatus(current),
    }));
    return finalizeReport(state);
  }
  if (
    state.synthesis.status === "error" ||
    state.synthesis.status === "recoverable" ||
    state.synthesis.status === "indeterminate"
  ) {
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: current.synthesis?.status === "recoverable" ? "awaiting-recovery" : "awaiting-owner",
    }));
    return finalizeReport(state);
  }
  let reservedSynthesis = false;
  const synthesisClaimToken = randomUUID();
  state = await mutateBatchState(batchId, (current) => {
    const synthesis = current.synthesis;
    if (
      !synthesis ||
      synthesis.sessionId ||
      ["completed", "error", "recoverable"].includes(synthesis.status)
    ) {
      return current;
    }
    if (synthesis.dispatchReservation && isProcessAlive(synthesis.dispatchReservation.pid)) {
      return current;
    }
    reservedSynthesis = true;
    return {
      ...current,
      status: "synthesizing",
      synthesis: {
        ...synthesis,
        status: "sealed",
        dispatchReservation: {
          pid: process.pid,
          token: synthesisClaimToken,
          reservedAt: new Date().toISOString(),
        },
      },
    };
  });
  if (!reservedSynthesis) {
    return finalizeReport(state);
  }
  try {
    const sealed = await sealSynthesisInput(state, { assemblePrompt: deps.assemblePrompt });
    state = await mutateBatchState(batchId, (current) => {
      if (current.synthesis?.dispatchReservation?.token !== synthesisClaimToken) {
        throw new Error(`Lost synthesis seal claim for batch ${batchId}.`);
      }
      return {
        ...current,
        status: "synthesizing",
        synthesis: {
          ...current.synthesis,
          status: "sealed",
          inputManifestSha256: sealed.inputManifest.inputManifestSha256,
          inputManifestPath: path.join(
            getBatchPaths(batchId).inputs,
            "synthesis",
            "input-manifest.json",
          ),
          outputPath: childOutputPath(batchId, current.synthesis.id, "synthesis"),
          dispatchReservation: {
            pid: process.pid,
            token: synthesisClaimToken,
            reservedAt: new Date().toISOString(),
          },
        },
      };
    });
    const created = await createChildSession({
      state,
      lane: state.synthesis!,
      role: "synthesis",
      browserConfig,
      sealed,
      store,
    });
    state = await mutateBatchState(batchId, (current) => {
      if (current.synthesis?.dispatchReservation?.token !== synthesisClaimToken) {
        throw new Error(`Lost synthesis dispatch claim for batch ${batchId}.`);
      }
      return {
        ...current,
        status: "synthesizing",
        synthesis: {
          ...current.synthesis,
          status: "claimed",
          sessionId: created.id,
          attempts: [
            {
              attempt: 1,
              sessionId: created.id,
              createdAt: created.createdAt,
              phase: "claimed" as const,
              claimedAt: new Date().toISOString(),
            },
          ],
          dispatchReservation: {
            pid: process.pid,
            token: synthesisClaimToken,
            reservedAt: new Date().toISOString(),
          },
        },
      };
    });
    await executePreparedActions(
      batchId,
      [
        {
          laneId: state.synthesis!.id,
          role: "synthesis",
          kind: "dispatch",
          claimToken: synthesisClaimToken,
        },
      ],
      browserConfig,
      options,
      deps,
    );
    state = await mutateBatchState(batchId, async (current) => {
      const reconciled = await reconcileBatchState(current, store);
      return { ...reconciled, status: classifyParentStatus(reconciled) };
    });
    return finalizeReport(state);
  } catch (error) {
    const code =
      error instanceof BatchSynthesisInputTooLargeError
        ? error.code
        : "batch-synthesis-sealing-failed";
    state = await mutateBatchState(batchId, (current) => ({
      ...current,
      status: "awaiting-owner",
      synthesis: {
        ...current.synthesis!,
        status: "error",
        lastError: {
          code,
          message: error instanceof Error ? error.message : String(error),
          retrySafe: false,
        },
      },
      lastError: { code, message: error instanceof Error ? error.message : String(error) },
    }));
    return finalizeReport(state);
  }
}

async function finalizeReport(state: BatchStateV1): Promise<BatchRunResult> {
  const manifest = await readNormalizedBatchManifest(state.batchId);
  const report = await renderBatch(manifest, state);
  const reportPath = getBatchPaths(state.batchId).report;
  await writeOwnerFileAtomic(reportPath, report);
  return { state, reportPath };
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
      })),
    }));
  } catch (error) {
    return mutateBatchState(state.batchId, (current) => ({
      ...current,
      status: "error",
      lastError: {
        code: "batch-first-stage-seal-incomplete",
        message: `The process stopped before a complete first-stage seal could be verified: ${error instanceof Error ? error.message : String(error)}. Start a new batch from the manifest; no child prompt was dispatched.`,
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

async function recoverCompletedEvidence(
  initial: BatchStateV1,
  store: SessionStore,
): Promise<BatchStateV1> {
  let state = initial;
  for (const lane of [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])]) {
    if (!lane.sessionId || !lane.inputManifestSha256 || !lane.outputPath) continue;
    const metadata = await store.readSession(lane.sessionId);
    if (!metadata) continue;
    if (lane.status === "completed" && !lane.outputSha256) {
      try {
        const answer = await ensureAnswerOutput(metadata, lane.outputPath, {
          requireTranscriptMatch: true,
        });
        const outputSha256 = createHash("sha256").update(answer).digest("hex");
        await writeAnswerReceipt(initial.batchId, lane, metadata, {
          status: "completed",
          answerSha256: outputSha256,
          answerBytes: answer.length,
        });
        state = await mutateBatchState(initial.batchId, (current) =>
          updateLane(current, lane, {
            outputSha256,
            completedAt: metadata.completedAt ?? lane.completedAt ?? new Date().toISOString(),
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
    } else if (lane.status === "error") {
      await writeAnswerReceipt(initial.batchId, lane, metadata, {
        status: "error",
        error: lane.lastError?.message ?? metadata.errorMessage ?? "Child session failed.",
      });
    }
  }
  return state;
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

async function writeAnswerReceipt(
  batchId: string,
  lane: BatchLaneState,
  metadata: SessionMetadata,
  outcome: Pick<BatchAnswerReceiptV1, "status" | "answerSha256" | "answerBytes" | "error">,
): Promise<void> {
  const receipt: BatchAnswerReceiptV1 = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId,
    laneId: lane.id,
    role: lane.role,
    sessionId: metadata.id,
    status: outcome.status,
    capturedAt: new Date().toISOString(),
    inputManifestSha256: lane.inputManifestSha256!,
    answerSha256: outcome.answerSha256,
    answerBytes: outcome.answerBytes,
    conversationId: metadata.browser?.runtime?.conversationId,
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
      parsed.sessionId !== receipt.sessionId ||
      parsed.inputManifestSha256 !== receipt.inputManifestSha256 ||
      parsed.status !== receipt.status ||
      parsed.answerSha256 !== receipt.answerSha256 ||
      parsed.answerBytes !== receipt.answerBytes
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

function buildChildRunOptions(
  state: BatchStateV1,
  laneId: string,
  artifacts: SealedBrowserPromptArtifacts,
  outputPath: string,
): RunOracleOptions {
  return {
    prompt: artifacts.composerText,
    model: "gpt-5-pro",
    file: artifacts.attachments.map((attachment) => attachment.path),
    slug: `${state.slug}-${laneId}`,
    sessionId: undefined,
    silent: true,
    search: false,
    verbose: false,
    heartbeatIntervalMs: 30_000,
    browserAttachments: "always",
    browserInlineFiles: false,
    browserBundleFiles: true,
    browserBundleFormat: "auto",
    bundleLabel: `${state.project}--${laneId}--sources`,
    writeOutputPath: outputPath,
  };
}

async function ensureAnswerOutput(
  metadata: SessionMetadata,
  outputPath: string,
  options: { requireTranscriptMatch?: boolean } = {},
): Promise<Buffer> {
  const existing = await fs.readFile(outputPath).catch(() => null);
  const transcript = metadata.artifacts?.find((artifact) => artifact.kind === "transcript");
  if (existing && existing.length > 0 && !options.requireTranscriptMatch) return existing;
  if (!transcript) {
    if (existing && existing.length > 0 && !options.requireTranscriptMatch) return existing;
    throw new Error(`Session ${metadata.id} completed without an answer output or transcript.`);
  }
  const raw = await fs.readFile(transcript.path, "utf8");
  const marker = "\n## Answer\n\n";
  const start = raw.indexOf(marker);
  if (start < 0) throw new Error(`Session ${metadata.id} transcript has no answer section.`);
  const answer = raw
    .slice(start + marker.length)
    .split("\n## Artifacts\n", 1)[0]
    ?.trim();
  if (!answer) throw new Error(`Session ${metadata.id} transcript answer is empty.`);
  const transcriptAnswer = Buffer.from(`${answer}\n`, "utf8");
  if (existing && existing.length > 0) {
    if (!existing.equals(transcriptAnswer)) {
      throw new Error(
        `Session ${metadata.id} output differs from its transcript; refusing to establish a receipt.`,
      );
    }
    return existing;
  }
  await writeOwnerFileAtomic(outputPath, transcriptAnswer);
  return transcriptAnswer;
}

async function clearReservation(batchId: string, action: PreparedAction): Promise<void> {
  await mutateBatchState(batchId, (state) => {
    const clear = (lane: BatchLaneState): BatchLaneState =>
      lane.id === action.laneId &&
      lane.role === action.role &&
      lane.dispatchReservation?.token === action.claimToken
        ? {
            ...lane,
            status: "session-created",
            dispatchReservation: undefined,
            attempts: lane.attempts.map((attempt, index) =>
              index === lane.attempts.length - 1 && attempt.phase === "claimed"
                ? { ...attempt, phase: "created" as const, claimedAt: undefined }
                : attempt,
            ),
          }
        : lane;
    return {
      ...state,
      lanes: state.lanes.map(clear),
      ...(state.synthesis ? { synthesis: clear(state.synthesis) } : {}),
    };
  });
}

async function markActionStarted(batchId: string, action: PreparedAction): Promise<void> {
  await mutateBatchState(batchId, (state) => {
    const startedAt = new Date().toISOString();
    const mark = (lane: BatchLaneState): BatchLaneState => {
      if (lane.id !== action.laneId || lane.role !== action.role) return lane;
      if (
        lane.status !== "claimed" ||
        !lane.dispatchReservation ||
        lane.dispatchReservation.pid !== process.pid ||
        lane.dispatchReservation.token !== action.claimToken
      ) {
        throw new Error(`Lost dispatch claim for ${action.role} ${action.laneId}.`);
      }
      return {
        ...lane,
        status: "running",
        startedAt: lane.startedAt ?? startedAt,
        attempts: lane.attempts.map((attempt, index) =>
          index === lane.attempts.length - 1
            ? { ...attempt, phase: "started" as const, dispatchStartedAt: startedAt }
            : attempt,
        ),
      };
    };
    return {
      ...state,
      status: action.role === "synthesis" ? "synthesizing" : "running",
      lanes: state.lanes.map(mark),
      ...(state.synthesis ? { synthesis: mark(state.synthesis) } : {}),
    };
  });
}

function completeCurrentAttempt(
  attempts: BatchLaneState["attempts"],
  completedAt = new Date().toISOString(),
): BatchLaneState["attempts"] {
  return attempts.map((attempt, index) =>
    index === attempts.length - 1
      ? {
          ...attempt,
          phase: "completed" as const,
          completedAt: completedAt ?? new Date().toISOString(),
        }
      : attempt,
  );
}

function failCurrentAttempt(attempts: BatchLaneState["attempts"]): BatchLaneState["attempts"] {
  return attempts.map((attempt, index) =>
    index === attempts.length - 1 && attempt.phase === "started"
      ? { ...attempt, phase: "failed" as const }
      : attempt,
  );
}

function resolveEffectiveCaps(
  loaded: LoadedBatchManifest,
  config: UserConfig,
  browserConfig: BrowserSessionConfig,
  cliMaxParallel?: number,
) {
  const localParallel = resolvePositiveInt(config.batch?.maxParallel, DEFAULT_BATCH_MAX_PARALLEL);
  const browserParallel = resolvePositiveInt(
    browserConfig.maxConcurrentTabs ?? config.browser?.maxConcurrentTabs,
    DEFAULT_BATCH_MAX_PARALLEL,
  );
  const manifestParallel = resolvePositiveInt(
    loaded.manifest.policy?.maxParallel,
    DEFAULT_BATCH_MAX_PARALLEL,
  );
  const requested =
    cliMaxParallel === undefined ? Number.POSITIVE_INFINITY : resolvePositiveInt(cliMaxParallel, 1);
  const maxParallel = Math.min(localParallel, browserParallel, manifestParallel, requested);
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

function assertBatchEnabled(config: UserConfig): void {
  if (config.batch?.enabled === false) {
    throw new Error("Batch Oracle is disabled by the local owner config (batch.enabled=false). ");
  }
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function childOutputPath(batchId: string, laneId: string, role: "lane" | "synthesis"): string {
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
