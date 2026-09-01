import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import type { BatchSourceManifestV1, BatchStateV1, LoadedBatchManifest } from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";
import { withBatchMutationLock } from "./lock.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// Pre-R9 Batch state remains readable but cannot relaunch its legacy browser
// children. Keep every referenced legacy session protected until that parent
// has published a completed or owner-accepted partial result.
const CHILD_SESSION_RELEASE_STATUSES = new Set(["completed", "partial"]);
const mutationTails = new Map<string, Promise<void>>();

export interface BatchPaths {
  root: string;
  sourceManifest: string;
  normalizedManifest: string;
  sourceManifestIdentity: string;
  state: string;
  report: string;
  inputs: string;
  outputs: string;
  firstStageSeal: string;
  sourceSnapshot: string;
}

export interface InitializeBatchOptions {
  loaded: LoadedBatchManifest;
  batchId: string;
  sourceManifest?: BatchSourceManifestV1;
  effectiveMaxParallel: number;
  effectiveMaxChildSessions: number;
}

export function getBatchesDir(): string {
  return path.join(getOracleHomeDir(), "batches");
}

export function createBatchId(slug: string, now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${slug}-${timestamp}-${randomBytes(2).toString("hex")}`;
}

export function getBatchPaths(batchId: string): BatchPaths {
  assertBatchId(batchId);
  const root = path.join(getBatchesDir(), batchId);
  return {
    root,
    sourceManifest: path.join(root, "manifest.source.json5"),
    normalizedManifest: path.join(root, "manifest.normalized.json"),
    sourceManifestIdentity: path.join(root, "source-manifest.json"),
    state: path.join(root, "state.json"),
    report: path.join(root, "report.md"),
    inputs: path.join(root, "inputs"),
    outputs: path.join(root, "outputs"),
    firstStageSeal: path.join(root, "inputs", "first-stage-seal.json"),
    sourceSnapshot: path.join(root, "inputs", "source-snapshot"),
  };
}

export async function initializeBatchStore(options: InitializeBatchOptions): Promise<BatchStateV1> {
  const paths = getBatchPaths(options.batchId);
  await ensureOwnerDir(getBatchesDir());
  await fs.mkdir(paths.root, { mode: DIR_MODE });
  await Promise.all([
    ensureOwnerDir(paths.inputs),
    ensureOwnerDir(paths.outputs),
    writeOwnerFileAtomic(paths.sourceManifest, options.loaded.sourceText),
    writeJsonAtomic(paths.normalizedManifest, options.loaded.manifest),
    ...(options.sourceManifest
      ? [writeJsonAtomic(paths.sourceManifestIdentity, options.sourceManifest)]
      : []),
  ]);
  const now = new Date().toISOString();
  const state: BatchStateV1 = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId: options.batchId,
    slug: options.loaded.manifest.slug,
    project: options.loaded.manifest.project,
    objective: options.loaded.manifest.objective,
    status: "preparing",
    createdAt: now,
    updatedAt: now,
    cwd: options.loaded.cwd,
    sourceManifestSha256:
      options.sourceManifest?.snapshotManifestSha256 ?? options.sourceManifest?.manifestSha256,
    sourceSnapshotManifestSha256: options.sourceManifest?.snapshotManifestSha256,
    effectiveMaxParallel: options.effectiveMaxParallel,
    effectiveMaxChildSessions: options.effectiveMaxChildSessions,
    lanes: options.loaded.manifest.lanes.map((lane) => ({
      id: lane.id,
      role: "lane",
      status: "pending",
      required: true,
      attempts: [],
    })),
    ...(options.loaded.manifest.synthesis
      ? {
          synthesis: {
            id: options.loaded.manifest.synthesis.id,
            role: "synthesis",
            status: "pending",
            required: false,
            attempts: [],
          },
        }
      : {}),
  };
  await writeBatchState(state);
  return state;
}

export async function readBatchState(batchId: string): Promise<BatchStateV1> {
  const raw = await fs.readFile(getBatchPaths(batchId).state, "utf8");
  const parsed = JSON.parse(raw) as BatchStateV1;
  if (parsed.schemaVersion !== BATCH_SCHEMA_VERSION || parsed.batchId !== batchId) {
    throw new Error(`Batch ${batchId} has invalid state identity.`);
  }
  return parsed;
}

export async function writeBatchState(state: BatchStateV1): Promise<void> {
  await writeJsonAtomic(getBatchPaths(state.batchId).state, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export async function mutateBatchState(
  batchId: string,
  mutate: (state: BatchStateV1) => BatchStateV1 | Promise<BatchStateV1>,
): Promise<BatchStateV1> {
  const previous = mutationTails.get(batchId) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  mutationTails.set(batchId, tail);
  await previous.catch(() => undefined);
  try {
    return await withBatchMutationLock(batchId, async () => {
      const state = await readBatchState(batchId);
      const next = await mutate(state);
      await writeBatchState(next);
      return next;
    });
  } finally {
    releaseTurn();
    if (mutationTails.get(batchId) === tail) {
      mutationTails.delete(batchId);
    }
  }
}

export async function readNormalizedBatchManifest(
  batchId: string,
): Promise<LoadedBatchManifest["manifest"]> {
  const raw = await fs.readFile(getBatchPaths(batchId).normalizedManifest, "utf8");
  return JSON.parse(raw) as LoadedBatchManifest["manifest"];
}

export async function listBatchStates(): Promise<BatchStateV1[]> {
  const entries = await fs.readdir(getBatchesDir(), { withFileTypes: true }).catch(() => []);
  const batchDirs = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".mutation.lock.stale-"),
  );
  const results = await Promise.allSettled(batchDirs.map((entry) => readBatchState(entry.name)));
  const unreadable = results
    .map((result, index) => ({ result, batchId: batchDirs[index]!.name }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; batchId: string } =>
        entry.result.status === "rejected",
    );
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot prove batch-session pruning safety because batch state is unreadable: ${unreadable
        .map(
          ({ batchId, result }) =>
            `${batchId} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`,
        )
        .join(", ")}`,
    );
  }
  return results
    .map((result) => (result as PromiseFulfilledResult<BatchStateV1>).value)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listProtectedBatchSessionIds(): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  for (const state of await listBatchStates()) {
    if (CHILD_SESSION_RELEASE_STATUSES.has(state.status)) continue;
    for (const lane of [...state.lanes, ...(state.synthesis ? [state.synthesis] : [])]) {
      if (lane.sessionId) protectedIds.add(lane.sessionId);
      for (const attempt of lane.attempts) {
        if (attempt.sessionId) protectedIds.add(attempt.sessionId);
      }
    }
  }
  return protectedIds;
}

export async function ensureOwnerDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await fs.chmod(dir, DIR_MODE);
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeOwnerFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeOwnerFileAtomic(
  target: string,
  content: string | Buffer,
): Promise<void> {
  await ensureOwnerDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: FILE_MODE });
    await fs.rename(temporary, target);
    if (process.platform !== "win32") await fs.chmod(target, FILE_MODE);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function assertBatchId(batchId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*(?:-[0-9TZ]+-[a-f0-9]{4})?$/u.test(batchId)) {
    throw new Error(`Unsafe batch ID: ${batchId}`);
  }
}
