import { chmod, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MUTATION_DATABASE = "browser-lock-mutations.sqlite";
const localMutationTails = new Map<string, Promise<void>>();

export async function withBrowserLockMutation<T>(
  runtimeRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  await mkdir(resolvedRuntimeRoot, { recursive: true, mode: 0o700 });
  const runtimeRealpath = await realpath(resolvedRuntimeRoot);
  const runDirectory = path.join(runtimeRealpath, "run");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(runDirectory, 0o700);
  const databasePath = path.join(runDirectory, MUTATION_DATABASE);
  return withLocalMutationQueue(databasePath, async () => {
    const database = new DatabaseSync(databasePath);
    let transactionOpen = false;
    try {
      if (process.platform !== "win32") await chmod(databasePath, 0o600);
      database.exec("PRAGMA busy_timeout = 30000");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const result = await operation();
      database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Closing the connection releases the mutation lock even if rollback fails.
        }
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

async function withLocalMutationQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = localMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.catch(() => undefined).then(() => owned);
  localMutationTails.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (localMutationTails.get(key) === tail) localMutationTails.delete(key);
  }
}
