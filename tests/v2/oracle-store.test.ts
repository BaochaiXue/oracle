import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  JOB_EVENT_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  type JobEvent,
  type JobSpec,
  type ObjectRef,
} from "../../packages/oracle-kernel/src/index.js";
import {
  ObjectIntegrityError,
  OracleStore,
  StateVersionConflictError,
  StoreFaultError,
} from "../../packages/oracle-store/src/index.js";

const roots: string[] = [];
const PROMPT_TEXT = "Review this durable job.\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-store-"));
  roots.push(root);
  let nowMs = Date.parse("2026-08-31T08:00:00.000Z");
  let nextId = 1;
  const store = new OracleStore({
    rootDir: path.join(root, "v2"),
    sessionsDir: path.join(root, "sessions"),
    now: () => new Date(nowMs),
    idGenerator: () => `job_${nextId++}`,
  });
  return {
    root,
    store,
    setNow(value: string) {
      nowMs = Date.parse(value);
    },
  };
}

function seedJob(store: OracleStore, options: { idempotencyKey?: string; jobId?: string } = {}) {
  const prompt = store.putObject(Buffer.from(PROMPT_TEXT), {
    mediaType: "text/plain",
    objectClass: "prompt",
  });
  const spec = jobSpec(prompt, options.idempotencyKey ?? "request-1");
  const admission = store.admitJob(spec, options.jobId ? { jobId: options.jobId } : undefined);
  return { prompt, spec, admission };
}

function jobSpec(prompt: ObjectRef & { objectClass: "prompt" }, idempotencyKey: string): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: `request-${idempotencyKey}`,
    idempotency: { scope: "test", key: idempotencyKey },
    owner: { kind: "ordinary", sessionSlug: "store-fixture" },
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

function started(attempt = 1): JobEvent {
  return { schemaVersion: JOB_EVENT_SCHEMA_VERSION, type: "preparation-started", attempt };
}

describe("Oracle v2 content-addressed storage", () => {
  test("writes owner-only objects atomically and verifies their bytes on every read", () => {
    const { store } = harness();
    const first = store.putObject(Buffer.from(PROMPT_TEXT), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const second = store.putObject(Buffer.from(PROMPT_TEXT), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });

    expect(second).toEqual(first);
    expect(store.readObject(first).toString("utf8")).toBe(PROMPT_TEXT);
    expect(statSync(store.objectPath(first.sha256)).mode & 0o777).toBe(0o600);

    writeFileSync(store.objectPath(first.sha256), "corrupt", { mode: 0o600 });
    expect(() => store.readObject(first)).toThrow(ObjectIntegrityError);
    store.close();
  });

  test("rejects a caller-supplied digest that does not match the bytes", () => {
    const { store } = harness();
    expect(() =>
      store.putObject(Buffer.from(PROMPT_TEXT), {
        mediaType: "text/plain",
        objectClass: "prompt",
        expectedSha256: "d".repeat(64),
      }),
    ).toThrow(/expected SHA-256/u);
    store.close();
  });
});

describe("Oracle v2 job ledger", () => {
  test("admits one job per explicit idempotency key and returns the original on retry", () => {
    const { store } = harness();
    const first = seedJob(store, { idempotencyKey: "same", jobId: "job_first" }).admission;
    const second = store.admitJob(first.job.spec, { jobId: "job_second" });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, specMatches: true, job: { id: "job_first" } });
    expect(
      store.admitJob({ ...first.job.spec, requestId: "conflicting-retry" }, { jobId: "job_third" }),
    ).toMatchObject({ created: false, specMatches: false, job: { id: "job_first" } });
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listEvents("job_first")).toMatchObject([{ seq: 1, type: "job-admitted" }]);
    store.close();
  });

  test("rolls back both event and snapshot around every injected append fault", () => {
    const { store } = harness();
    const { admission } = seedJob(store, { jobId: "job_fault" });
    const startedJob = store.appendEvent("job_fault", 0, started());
    expect(startedJob).toMatchObject({ stateVersion: 1, state: { kind: "preparing" } });

    const deferred: JobEvent = {
      schemaVersion: JOB_EVENT_SCHEMA_VERSION,
      type: "preparation-deferred",
    };
    for (const faultAt of ["after-event-insert", "after-state-update"] as const) {
      expect(() => store.appendEvent("job_fault", 1, deferred, { faultAt })).toThrow(
        StoreFaultError,
      );
      expect(store.getJob("job_fault")).toMatchObject({
        id: admission.job.id,
        stateVersion: 1,
        state: { kind: "preparing" },
      });
      expect(store.listEvents("job_fault")).toHaveLength(2);
    }

    expect(store.appendEvent("job_fault", 1, deferred)).toMatchObject({
      stateVersion: 2,
      state: { kind: "queued" },
    });
    expect(() => store.appendEvent("job_fault", 1, started(2))).toThrow(StateVersionConflictError);
    store.close();
  });

  test("keeps projection failure separate and rebuilds deleted session projections", () => {
    const { store } = harness();
    const { admission } = seedJob(store, { jobId: "job_projection" });
    const projectionDir = store.projectionPath(admission.job.id);
    expect(readFileSync(path.join(projectionDir, "prompt.md"), "utf8")).toBe(PROMPT_TEXT);
    expect(JSON.parse(readFileSync(path.join(projectionDir, "meta.json"), "utf8"))).toMatchObject({
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId: "job_projection",
      state: { kind: "queued" },
    });

    rmSync(projectionDir, { recursive: true, force: true });
    expect(store.rebuildProjections()).toBe(1);
    expect(readFileSync(path.join(projectionDir, "prompt.md"), "utf8")).toBe(PROMPT_TEXT);
    expect(readFileSync(path.join(projectionDir, "log.jsonl"), "utf8")).toContain(
      '"type":"job-admitted"',
    );
    store.close();
  });

  test("passes SQLite quick_check and creates a bounded owner-only backup", async () => {
    const { store } = harness();
    seedJob(store, { jobId: "job_backup" });
    expect(store.verifyStorage()).toMatchObject({ database: "ok", objectErrors: [] });

    const backupPath = await store.createBackup();
    expect(statSync(store.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(store.listBackups()).toEqual([backupPath]);
    store.close();
  });

  test("blocks startup when the snapshot no longer matches the authority event log", () => {
    const { root, store } = harness();
    seedJob(store, { jobId: "job_mismatch" });
    const databasePath = store.databasePath;
    store.close();

    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE jobs SET state_kind = 'preparing', state_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "preparing", preparationAttempt: 9 }), "job_mismatch");
    database.close();

    expect(
      () =>
        new OracleStore({
          rootDir: path.join(root, "v2"),
          sessionsDir: path.join(root, "sessions"),
        }),
    ).toThrow(/ledger verification failed/u);
  });

  test("pins unresolved debug evidence and prunes it after terminal closure", () => {
    const { store, setNow } = harness();
    const { admission } = seedJob(store, { jobId: "job_debug" });
    const debug = store.putObject(Buffer.from("sanitized diagnostic"), {
      mediaType: "text/plain",
      objectClass: "debug",
    });
    store.linkJobObject(admission.job.id, "debug:fixture", debug, "debug");

    setNow("2026-10-01T08:00:00.000Z");
    expect(
      store.pruneDebugObjects({ ttlMs: 14 * 24 * 60 * 60 * 1_000, maxBytes: 1, keepLatest: 0 }),
    ).toMatchObject({ deleted: 0, pinned: 1 });
    expect(store.hasObject(debug.sha256)).toBe(true);

    store.appendEvent("job_debug", 0, {
      schemaVersion: JOB_EVENT_SCHEMA_VERSION,
      type: "job-canceled-unsent",
      reason: "fixture complete",
    });
    expect(
      store.pruneDebugObjects({ ttlMs: 14 * 24 * 60 * 60 * 1_000, maxBytes: 1, keepLatest: 0 }),
    ).toMatchObject({ deleted: 1 });
    expect(store.hasObject(debug.sha256)).toBe(false);
    store.close();
  });
});
