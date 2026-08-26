import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { reconcileBatchState, deriveLaneSessionState } from "../../src/batch/reconcile.js";
import { initializeBatchStore } from "../../src/batch/store.js";
import { sessionStore, type SessionMetadata } from "../../src/sessionStore.js";
import type { BatchSourceManifestV1, LoadedBatchManifest } from "../../src/batch/types.js";

describe("batch reconciliation", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-reconcile-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-reconcile-cwd-"));
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("discovers a child written before its parent mapping and keeps the same session", async () => {
    const loaded = fixtureLoaded(cwd);
    const state = await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: fixtureSource(cwd),
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    state.lanes[0]!.inputManifestSha256 = "a".repeat(64);
    const child = await sessionStore.createSession(
      { prompt: "one", model: "gpt-5-pro", mode: "browser" },
      cwd,
    );
    await sessionStore.updateSession(child.id, {
      batch: {
        batchId: state.batchId,
        laneId: "one",
        role: "lane",
        attempt: 1,
        inputManifestSha256: "a".repeat(64),
      },
    });

    const reconciled = await reconcileBatchState(state, sessionStore);
    expect(reconciled.lanes[0]).toEqual(
      expect.objectContaining({
        sessionId: child.id,
        status: "session-created",
        inputManifestSha256: "a".repeat(64),
      }),
    );
    expect(reconciled.lanes[0]!.attempts).toEqual([
      expect.objectContaining({ attempt: 1, sessionId: child.id }),
    ]);
  });

  test("only classifies an explicitly unsubmitted and uncommitted gate as retry-safe", () => {
    const base = {
      id: "child",
      slug: "child",
      createdAt: new Date().toISOString(),
      status: "error" as const,
      mode: "browser" as const,
      models: [],
      notifications: { enabled: false, sound: false },
      options: { prompt: "test", model: "gpt-5-pro" },
    };
    const safe = deriveLaneSessionState({
      ...base,
      error: {
        category: "browser-automation",
        message: "gate",
        details: {
          retrySafe: true,
          submissionCommitted: false,
          runtime: { promptSubmitted: false, proTurnCommitted: false },
        },
      },
    });
    const committed = deriveLaneSessionState({
      ...base,
      error: {
        category: "browser-automation",
        message: "gate",
        details: { retrySafe: true, promptSubmitted: true, submissionCommitted: true },
      },
    });
    expect(safe).toEqual(
      expect.objectContaining({
        status: "recoverable",
        lastError: expect.objectContaining({ retrySafe: true, message: "gate" }),
      }),
    );
    expect(committed.lastError?.retrySafe).toBe(false);
  });

  test("keeps a live committed child running before applying recoverable-conversation rules", () => {
    const metadata: SessionMetadata = {
      id: "active-child",
      createdAt: new Date().toISOString(),
      status: "running",
      mode: "browser",
      models: [],
      notifications: { enabled: false, sound: false },
      options: { prompt: "test", model: "gpt-5-pro" },
      browser: {
        config: { transport: "cdp" } as never,
        runtime: {
          controllerPid: process.pid,
          promptSubmitted: true,
          proTurnCommitted: true,
          conversationId: "conversation-active",
          browserDisposition: "active",
        },
      },
    };
    const state = deriveLaneSessionState(metadata);
    expect(state).toEqual({ status: "running" });
    expect(deriveLaneSessionState(metadata, undefined, { actionSettled: true })).toEqual({
      status: "recoverable",
      clearReservation: true,
    });
  });

  test("fails closed when a started child has no runtime and no safe pre-submit receipt", () => {
    const metadata: SessionMetadata = {
      id: "lost-child",
      createdAt: new Date().toISOString(),
      status: "running",
      mode: "browser",
      models: [],
      notifications: { enabled: false, sound: false },
      options: { prompt: "test", model: "gpt-5-pro" },
    };
    const derived = deriveLaneSessionState(metadata, {
      id: "one",
      role: "lane",
      status: "running",
      required: true,
      attempts: [
        {
          attempt: 1,
          sessionId: metadata.id,
          createdAt: metadata.createdAt,
          phase: "started",
          dispatchStartedAt: metadata.createdAt,
        },
      ],
    });
    expect(derived).toEqual(
      expect.objectContaining({
        status: "indeterminate",
        lastError: expect.objectContaining({
          code: "batch-dispatch-outcome-indeterminate",
          retrySafe: false,
        }),
      }),
    );
  });

  test("does not select a latest orphan when the sealed digest is mismatched", async () => {
    const loaded = fixtureLoaded(cwd);
    const state = await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: fixtureSource(cwd),
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    state.lanes[0]!.inputManifestSha256 = "a".repeat(64);
    const child = await sessionStore.createSession(
      { prompt: "one", model: "gpt-5-pro", mode: "browser" },
      cwd,
    );
    await sessionStore.updateSession(child.id, {
      batch: {
        batchId: state.batchId,
        laneId: "one",
        role: "lane",
        attempt: 1,
        inputManifestSha256: "b".repeat(64),
      },
    });
    const reconciled = await reconcileBatchState(state, sessionStore);
    expect(reconciled.lanes[0]).toEqual(
      expect.objectContaining({
        status: "indeterminate",
        lastError: expect.objectContaining({ code: "batch-orphan-child-ambiguity" }),
      }),
    );
  });

  test("rejects two orphan children that claim the same attempt", async () => {
    const loaded = fixtureLoaded(cwd);
    const state = await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: fixtureSource(cwd),
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    const digest = "a".repeat(64);
    state.lanes[0]!.inputManifestSha256 = digest;
    for (const prompt of ["orphan one", "orphan duplicate"]) {
      const child = await sessionStore.createSession(
        { prompt, model: "gpt-5-pro", mode: "browser" },
        cwd,
      );
      await sessionStore.updateSession(child.id, {
        batch: {
          batchId: state.batchId,
          laneId: "one",
          role: "lane",
          attempt: 1,
          inputManifestSha256: digest,
        },
      });
    }
    const reconciled = await reconcileBatchState(state, sessionStore);
    expect(reconciled.lanes[0]).toEqual(
      expect.objectContaining({
        status: "indeterminate",
        lastError: expect.objectContaining({ code: "batch-orphan-child-ambiguity" }),
      }),
    );
  });
});

function fixtureLoaded(cwd: string): LoadedBatchManifest {
  const manifest = {
    schemaVersion: "oracle.batch.v1" as const,
    slug: "fixture-batch",
    project: "fixture",
    objective: "Reconcile children.",
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
    manifestSha256: "b".repeat(64),
    files: [],
  };
}
