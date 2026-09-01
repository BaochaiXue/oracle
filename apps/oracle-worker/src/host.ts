import path from "node:path";
import type { ProviderAdapter } from "../../../packages/oracle-kernel/src/index.js";
import { OracleClient } from "../../../packages/oracle-client/src/index.js";
import { getOracleHomeDir } from "../../../src/oracleHome.js";
import { resolveBrokerPaths, type BrokerPaths } from "../../../src/v2/broker.js";
import { CertifiedChatGptProvider } from "./certifiedProvider.js";
import { OracleWorker, WorkerAlreadyRunningError } from "./worker.js";

const EXISTING_WORKER_STARTUP_TIMEOUT_MS = 120_000;

export interface OracleWorkerHostOptions {
  paths?: BrokerPaths & { sessionsDir?: string };
  provider?: ProviderAdapter;
  waitForShutdown?: () => Promise<void>;
  onReady?: (status: { socketPath: string }) => void | Promise<void>;
  log?: (message: string) => void;
}

export async function runOracleWorkerHost(
  options: OracleWorkerHostOptions = {},
): Promise<"already-running" | "stopped"> {
  const log = options.log ?? console.log;
  const oracleHome = getOracleHomeDir();
  const paths = options.paths ?? resolveBrokerPaths({ oracleHomeDir: oracleHome });
  const signalWaiter = options.waitForShutdown ? undefined : createProcessSignalWaiter();
  const provider =
    options.provider ??
    new CertifiedChatGptProvider({ runtimeRoot: paths.rootDir, maxOpenPages: 3 });
  const worker = new OracleWorker({
    rootDir: paths.rootDir,
    sessionsDir: options.paths?.sessionsDir ?? path.join(oracleHome, "sessions"),
    socketPath: paths.socketPath,
    provider,
  });
  let started = false;
  try {
    for (let attempt = 0; attempt < 2 && !started; attempt += 1) {
      try {
        await worker.start();
        started = true;
      } catch (error) {
        if (!(error instanceof WorkerAlreadyRunningError)) throw error;
        const existing = await waitForExistingWorker(paths.socketPath);
        if (existing === "ready") {
          log(error.message);
          return "already-running";
        }
        if (existing === "starting") {
          throw new Error(`Oracle v2 worker at ${paths.socketPath} did not finish starting`);
        }
        if (attempt === 1) throw error;
      }
    }
    if (!started) throw new Error("Oracle v2 worker did not acquire its socket");
    log(`Oracle v2 worker ready at ${paths.socketPath}.`);
    await options.onReady?.({ socketPath: paths.socketPath });
    await (options.waitForShutdown ? options.waitForShutdown() : signalWaiter!.promise);
    return "stopped";
  } finally {
    try {
      if (started) await worker.stop();
    } finally {
      signalWaiter?.dispose();
    }
  }
}

type ExistingWorkerState = "absent" | "starting" | "ready";

async function inspectExistingWorker(socketPath: string): Promise<ExistingWorkerState> {
  const client = new OracleClient({ socketPath });
  try {
    const status = await client.getWorker();
    return status.phase === "starting" ? "starting" : "ready";
  } catch {
    return "absent";
  } finally {
    client.close();
  }
}

async function waitForExistingWorker(socketPath: string): Promise<ExistingWorkerState> {
  const deadline = Date.now() + EXISTING_WORKER_STARTUP_TIMEOUT_MS;
  while (true) {
    const state = await inspectExistingWorker(socketPath);
    if (state !== "starting" || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createProcessSignalWaiter(): { promise: Promise<void>; dispose(): void } {
  let onSignal: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    // Preserve an early shutdown request while worker startup is still acquiring resources.
    onSignal = finish;
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  return {
    promise,
    dispose() {
      if (!onSignal) return;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}
