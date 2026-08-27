import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { acquireBatchMutationLock } from "../../src/batch/lock.js";
import { ensureOwnerDir, getBatchPaths } from "../../src/batch/store.js";

describe("batch mutation lock", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-lock-"));
    setOracleHomeDirOverrideForTest(home);
    await ensureOwnerDir(getBatchPaths("fixture-batch").root);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await fs.rm(home, { recursive: true, force: true });
  });

  test("allows one mutator and releases by token", async () => {
    const first = await acquireBatchMutationLock("fixture-batch");
    await expect(acquireBatchMutationLock("fixture-batch")).rejects.toThrow(
      /already being mutated/u,
    );
    await first.release();
    const second = await acquireBatchMutationLock("fixture-batch");
    await second.release();
  });

  test("recovers an old dead-owner lock", async () => {
    const lockPath = path.join(getBatchPaths("fixture-batch").root, ".mutation.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z", token: "old" }),
      "utf8",
    );
    const lock = await acquireBatchMutationLock("fixture-batch", { staleMs: 1 });
    await lock.release();
  });

  test("recovers a fresh lock immediately when its owner is dead", async () => {
    const lockPath = path.join(getBatchPaths("fixture-batch").root, ".mutation.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString(), token: "dead" }),
      "utf8",
    );
    const lock = await acquireBatchMutationLock("fixture-batch");
    await lock.release();
  });

  test("recovers an empty lock directory after the owner publication grace expires", async () => {
    const lockPath = path.join(getBatchPaths("fixture-batch").root, ".mutation.lock");
    await fs.mkdir(lockPath);
    const old = new Date(Date.now() - 2_000);
    await fs.utimes(lockPath, old, old);
    const lock = await acquireBatchMutationLock("fixture-batch", { staleMs: 1 });
    await lock.release();
  });

  test("allows exactly one contender to reclaim a stale lock", async () => {
    const lockPath = path.join(getBatchPaths("fixture-batch").root, ".mutation.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z", token: "dead" }),
      "utf8",
    );
    const results = await Promise.allSettled([
      acquireBatchMutationLock("fixture-batch", { staleMs: 1 }),
      acquireBatchMutationLock("fixture-batch", { staleMs: 1 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBatchMutationLock>>> =>
        result.status === "fulfilled",
    );
    await winner!.value.release();
  });
});
