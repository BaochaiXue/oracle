import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

const DEFAULT_STALE_MS = 5 * 60 * 1000;

export interface BatchMutationLock {
  release(): Promise<void>;
}

export async function acquireBatchMutationLock(
  batchId: string,
  options: { staleMs?: number } = {},
): Promise<BatchMutationLock> {
  const lockPath = path.join(getOracleHomeDir(), "batches", batchId, ".mutation.lock");
  const token = randomUUID();
  const payload = JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() });
  try {
    await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    const stale = await isStaleLock(lockPath, options.staleMs ?? DEFAULT_STALE_MS);
    if (!stale) {
      throw new Error(`Batch ${batchId} is already being mutated by another process.`);
    }
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
  }
  return {
    release: async () => {
      const current = await fs.readFile(lockPath, "utf8").catch(() => "");
      if (current) {
        try {
          if ((JSON.parse(current) as { token?: string }).token !== token) return;
        } catch {
          return;
        }
      }
      await fs.unlink(lockPath).catch(() => undefined);
    },
  };
}

export async function withBatchMutationLock<T>(
  batchId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireBatchMutationLock(batchId);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: string };
    const age = parsed.createdAt
      ? Date.now() - Date.parse(parsed.createdAt)
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(parsed.pid)) return !isProcessAlive(parsed.pid);
    return age >= staleMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
