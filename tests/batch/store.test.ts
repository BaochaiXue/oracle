import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  getBatchPaths,
  initializeBatchStore,
  listProtectedBatchSessionIds,
  listBatchStates,
  readBatchState,
  writeBatchState,
} from "../../src/batch/store.js";
import type { BatchSourceManifestV1, LoadedBatchManifest } from "../../src/batch/types.js";
import { sessionStore } from "../../src/sessionStore.js";

describe("durable batch store", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-cwd-"));
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("writes owner-only atomic state and reads it after restart", async () => {
    const loaded = fixtureLoaded(cwd);
    const source = fixtureSource(cwd);
    const state = await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: source,
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    await writeBatchState({ ...state, status: "sealed" });
    expect((await readBatchState("fixture-batch")).status).toBe("sealed");
    expect(await listBatchStates()).toHaveLength(1);

    if (process.platform !== "win32") {
      const paths = getBatchPaths("fixture-batch");
      expect((await fs.stat(paths.root)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(paths.state)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(paths.normalizedManifest)).mode & 0o777).toBe(0o600);
    }
  });

  test("protects nonterminal batch children from time-based session pruning", async () => {
    const loaded = fixtureLoaded(cwd);
    const state = await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: fixtureSource(cwd),
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    const child = await sessionStore.createSession(
      { prompt: "protected", model: "gpt-5-pro", mode: "browser" },
      cwd,
    );
    await sessionStore.updateSession(child.id, {
      createdAt: "2000-01-01T00:00:00.000Z",
      batch: {
        batchId: state.batchId,
        laneId: "one",
        role: "lane",
        attempt: 1,
        inputManifestSha256: "d".repeat(64),
      },
    });
    await writeBatchState({
      ...state,
      status: "awaiting-recovery",
      lanes: state.lanes.map((lane) =>
        lane.id === "one"
          ? {
              ...lane,
              status: "recoverable",
              sessionId: child.id,
              attempts: [{ attempt: 1, sessionId: child.id, createdAt: child.createdAt }],
            }
          : lane,
      ),
    });

    expect(await listProtectedBatchSessionIds()).toContain(child.id);
    expect(await sessionStore.deleteOlderThan({ hours: 1 })).toEqual({ deleted: 0, remaining: 1 });
    expect(await sessionStore.readSession(child.id)).not.toBeNull();
  });
});

function fixtureLoaded(cwd: string): LoadedBatchManifest {
  const manifest = {
    schemaVersion: "oracle.batch.v1" as const,
    slug: "fixture-batch",
    project: "fixture",
    objective: "Test storage.",
    lanes: [
      {
        id: "one",
        title: "One",
        mandate: "A",
        whyThisLane: "A",
        falsificationTarget: "A",
        prompt: "A",
        outputContract: ["A"],
      },
      {
        id: "two",
        title: "Two",
        mandate: "B",
        whyThisLane: "B",
        falsificationTarget: "B",
        prompt: "B",
        outputContract: ["B"],
      },
    ],
  };
  return {
    sourcePath: path.join(cwd, "batch.json5"),
    sourceText: JSON.stringify(manifest),
    cwd,
    manifest,
    files: { sharedAuthority: [], lanes: { one: [], two: [] }, synthesis: [] },
  };
}

function fixtureSource(cwd: string): BatchSourceManifestV1 {
  return {
    schemaVersion: "oracle.batch.v1",
    batchId: "fixture-batch",
    capturedAt: new Date().toISOString(),
    cwd,
    git: {},
    manifestSha256: "a".repeat(64),
    files: [],
  };
}
