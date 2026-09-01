import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test as vitestTest } from "vitest";
import {
  CertifiedChatGptProvider,
  FakeProvider,
  OracleWorker,
  runOracleWorkerHost,
} from "../../apps/oracle-worker/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";

const roots: string[] = [];
const test = process.platform === "win32" ? vitestTest.skip : vitestTest;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-worker-host-"));
  roots.push(root);
  return {
    rootDir: path.join(root, "store"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
    intentDirectory: path.join(root, "intents"),
  };
}

describe("Oracle v2 production worker host", () => {
  test("installs the default shutdown listener before provider startup completes", async () => {
    const paths = hostPaths();
    let releaseProbe: (() => void) | undefined;
    let markProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const provider = new FakeProvider();
    const originalProbe = provider.probe.bind(provider);
    provider.probe = async () => {
      markProbeStarted?.();
      await probeGate;
      return originalProbe();
    };
    const existing = new Set(process.listeners("SIGTERM"));
    const running = runOracleWorkerHost({ paths, provider, log: () => undefined });
    await probeStarted;
    const listener = process.listeners("SIGTERM").find((candidate) => !existing.has(candidate));
    expect(listener).toBeDefined();

    listener?.("SIGTERM");
    releaseProbe?.();
    await expect(running).resolves.toBe("stopped");
    expect(existsSync(paths.socketPath)).toBe(false);
  });

  vitestTest("retains failed provider close handles for a later cleanup attempt", async () => {
    const provider = new CertifiedChatGptProvider({ runtimeRoot: temporaryRuntimeRoot() });
    let adapterCloseAttempts = 0;
    let runtimeCloseAttempts = 0;
    const mutable = provider as unknown as {
      adapter: { close(): Promise<void> };
      runtime: { close(): Promise<void> };
    };
    mutable.adapter = {
      async close() {
        adapterCloseAttempts += 1;
        if (adapterCloseAttempts === 1) throw new Error("adapter close failed");
      },
    };
    mutable.runtime = {
      async close() {
        runtimeCloseAttempts += 1;
        if (runtimeCloseAttempts === 1) throw new Error("runtime close failed");
      },
    };

    await expect(provider.close()).rejects.toThrow("certified provider cleanup failed");
    await expect(provider.close()).resolves.toBeUndefined();
    expect(adapterCloseAttempts).toBe(2);
    expect(runtimeCloseAttempts).toBe(2);
  });

  test("publishes readiness and closes its owned socket on shutdown", async () => {
    const paths = hostPaths();
    let releaseShutdown: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    let observedReady = false;
    const outcome = await runOracleWorkerHost({
      paths,
      provider: new FakeProvider(),
      waitForShutdown: () => shutdown,
      log: () => undefined,
      onReady: async ({ socketPath }) => {
        const client = new OracleClient({ socketPath });
        const status = await client.getWorker();
        client.close();
        observedReady = status.ready && status.provider === "compatible";
        releaseShutdown?.();
      },
    });

    expect(outcome).toBe("stopped");
    expect(observedReady).toBe(true);
    expect(existsSync(paths.socketPath)).toBe(false);
  });

  test("exits without starting a second provider when a healthy worker owns the socket", async () => {
    const paths = hostPaths();
    const existing = new OracleWorker({ ...paths, provider: new FakeProvider() });
    await existing.start();
    let shutdownWaited = false;
    const outcome = await runOracleWorkerHost({
      paths,
      provider: new FakeProvider(),
      waitForShutdown: async () => {
        shutdownWaited = true;
      },
      log: () => undefined,
    });

    expect(outcome).toBe("already-running");
    expect(shutdownWaited).toBe(false);
    const client = new OracleClient({ socketPath: paths.socketPath });
    expect((await client.getWorker()).ready).toBe(true);
    client.close();
    await existing.stop();
  });
});

function temporaryRuntimeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-provider-close-"));
  roots.push(root);
  return root;
}
