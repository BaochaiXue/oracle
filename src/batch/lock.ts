import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

const DEFAULT_STALE_MS = 5 * 60 * 1000;
const OWNER_PUBLICATION_GRACE_MS = 1_000;

export interface BatchMutationLock {
  release(): Promise<void>;
}

interface LockPayload {
  token: string;
  pid: number;
  createdAt: string;
}

export async function acquireBatchMutationLock(
  batchId: string,
  options: { staleMs?: number } = {},
): Promise<BatchMutationLock> {
  const batchRoot = path.join(getOracleHomeDir(), "batches", batchId);
  const lockPath = path.join(batchRoot, ".mutation.lock");
  const token = randomUUID();
  const payload: LockPayload = { token, pid: process.pid, createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(payload), {
        flag: "wx",
        mode: 0o600,
      });
      return ownedLock(lockPath, token);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const stale = await isStaleLock(lockPath, options.staleMs ?? DEFAULT_STALE_MS);
      if (!stale) {
        throw new Error(`Batch ${batchId} is already being mutated by another process.`);
      }
      const quarantine = path.join(batchRoot, `.mutation.lock.stale-${randomUUID()}`);
      try {
        await fs.rename(lockPath, quarantine);
      } catch (renameError) {
        if ((renameError as { code?: string }).code === "ENOENT") continue;
        throw renameError;
      }
      await fs.rm(quarantine, { recursive: true, force: true });
    }
  }
  throw new Error(`Batch ${batchId} lock ownership changed during stale-lock recovery.`);
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

function ownedLock(lockPath: string, token: string): BatchMutationLock {
  return {
    release: async () => {
      const current = await readLockPayload(lockPath);
      if (current?.token !== token) return;
      const quarantine = `${lockPath}.release-${token}`;
      try {
        await fs.rename(lockPath, quarantine);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
      await fs.rm(quarantine, { recursive: true, force: true });
    },
  };
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const parsed = await readLockPayload(lockPath);
  if (!parsed) {
    const stats = await fs.stat(lockPath).catch(() => null);
    if (!stats) return true;
    const age = Date.now() - stats.mtimeMs;
    return !Number.isFinite(age) || age >= Math.max(staleMs, OWNER_PUBLICATION_GRACE_MS);
  }
  if (Number.isFinite(parsed.pid)) return !isProcessAlive(parsed.pid);
  const age = Date.now() - Date.parse(parsed.createdAt ?? "");
  return !Number.isFinite(age) || age >= staleMs;
}

async function readLockPayload(lockPath: string): Promise<Partial<LockPayload> | null> {
  try {
    const stats = await fs.stat(lockPath);
    const ownerPath = stats.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    return JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<LockPayload>;
  } catch {
    return null;
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
