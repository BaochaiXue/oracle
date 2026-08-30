import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchedChrome } from "chrome-launcher";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import {
  acquireDedicatedChromeForRun,
  readDedicatedBrowserRuntimeReceipt,
  writeDedicatedBrowserRuntimeReceipt,
  type DedicatedBrowserRuntimeReceipt,
  type ObservedProcess,
} from "../../src/browser/dedicatedChromeSupervisor.js";
import { readChromePid, readDevToolsPort } from "../../src/browser/profileState.js";

const noopLogger = Object.assign((_message: string) => {}, { verbose: false });
const currentExecutable = "/tmp/oracle-cft-current";
const oldExecutable = "/tmp/oracle-cft-old";
const startTime = "Sat Aug 30 12:00:00 2026";

interface ManagedProcessState {
  running: boolean;
  pid: number;
  port: number;
  executable: string;
}

function managedDeps(profileDir: string, state: ManagedProcessState) {
  const launch = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state.running = true;
    state.pid = 4200;
    state.port = 9333;
    state.executable = currentExecutable;
    return {
      pid: state.pid,
      port: state.port,
      process: undefined,
      kill: vi.fn(async () => undefined),
    } as unknown as LaunchedChrome;
  });
  return {
    resolveExecutable: vi.fn(async () => currentExecutable),
    listInstalled: vi.fn(async () => [
      { buildId: "140", platform: "mac", executablePath: currentExecutable },
      { buildId: "139", platform: "mac", executablePath: oldExecutable },
    ]),
    findProfileProcess: vi.fn(async () =>
      state.running ? { pid: state.pid, port: state.port } : null,
    ),
    observeProcess: vi.fn(async (pid: number): Promise<ObservedProcess | null> => {
      if (!state.running || pid !== state.pid) return null;
      return {
        pid,
        ppid: 1,
        command: `${state.executable} --user-data-dir=${profileDir} --remote-debugging-port=${state.port}`,
        executablePath: state.executable,
        executableRealpath: state.executable,
        processStartTime: startTime,
      };
    }),
    probe: vi.fn(async ({ port }: { port: number }) =>
      state.running && port === state.port
        ? ({ ok: true } as const)
        : ({ ok: false, error: "offline" } as const),
    ),
    launch,
  };
}

function config(profileDir: string) {
  return resolveBrowserConfig({
    manualLogin: true,
    manualLoginProfileDir: profileDir,
    chromePath: currentExecutable,
    profileLockTimeoutMs: 2_000,
    reuseChromeWaitMs: 0,
  });
}

async function writeRuntimeReceipt(
  profileDir: string,
  state: ManagedProcessState,
  overrides: Partial<DedicatedBrowserRuntimeReceipt> = {},
) {
  const profileRealpath = await fs.realpath(profileDir);
  await writeDedicatedBrowserRuntimeReceipt(profileDir, {
    version: 1,
    pid: state.pid,
    processStartTime: startTime,
    profileRealpath,
    executableRealpath: state.executable,
    buildId: state.executable === oldExecutable ? "139" : "140",
    platform: "darwin",
    debugHost: "127.0.0.1",
    debugPort: state.port,
    launchedAt: "2026-08-30T04:00:00.000Z",
    lastVerifiedAt: "2026-08-30T04:00:01.000Z",
    ...overrides,
  });
}

describe("dedicated Chrome acquisition", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("serializes parallel launch and makes the second run reuse the first browser", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-launch-lock-"));
    const state: ManagedProcessState = {
      running: false,
      pid: 0,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    try {
      const first = acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "first" },
        deps,
      );
      const second = acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "second" },
        deps,
      );

      const results = await Promise.all([first, second]);

      expect(deps.launch).toHaveBeenCalledTimes(1);
      expect(results.filter((result) => result.reusedChrome === null)).toHaveLength(1);
      expect(results.filter((result) => result.reusedChrome?.port === 9333)).toHaveLength(1);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("reuses a healthy old Oracle-managed generation and records deferred rollover", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-old-gen-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4300,
      port: 9333,
      executable: oldExecutable,
    };
    const deps = managedDeps(profileDir, state);
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), `${state.pid}\n`);
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), `${state.port}\n`);
      await writeRuntimeReceipt(profileDir, state);

      const result = await acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "old" },
        deps,
      );

      expect(result.reusedChrome?.pid).toBe(state.pid);
      expect(result.bootstrap.action).toBe("reuse-compatible-and-defer-rollover");
      expect(result.bootstrap.rolloverPending).toBe(true);
      expect(deps.launch).not.toHaveBeenCalled();
      expect((await readDedicatedBrowserRuntimeReceipt(profileDir))?.rolloverPending).toBe(true);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("fails closed for a foreign browser and says the review was not sent", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-foreign-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4400,
      port: 9333,
      executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    };
    const deps = managedDeps(profileDir, state);
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), `${state.pid}\n`);
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), `${state.port}\n`);

      await expect(
        acquireDedicatedChromeForRun(
          { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "foreign" },
          deps,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("The review was not sent"),
        details: expect.objectContaining({
          promptSubmitted: false,
          externalDataSent: false,
          retrySafe: true,
        }),
      });
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("rebinds a stale recorded pid to the live exact-profile owner", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-rebind-pid-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4500,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), "9999\n");
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), `${state.port}\n`);

      const result = await acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "rebind" },
        deps,
      );

      expect(result.reusedChrome?.pid).toBe(state.pid);
      await expect(readChromePid(profileDir)).resolves.toBe(state.pid);
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("rebinds a stale recorded port to the live exact-profile endpoint", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-rebind-port-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4600,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), `${state.pid}\n`);
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), "9444\n");

      await acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "port" },
        deps,
      );

      await expect(readDevToolsPort(profileDir)).resolves.toBe(state.port);
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("clears stale pid, port, and singleton files before one launch", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-stale-"));
    const state: ManagedProcessState = {
      running: false,
      pid: 0,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    const staleFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), "9876\n");
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), "9444\n");
      for (const filename of staleFiles) await fs.writeFile(path.join(profileDir, filename), "x");

      const result = await acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "stale" },
        deps,
      );

      expect(result.bootstrap.repairAttempted).toBe(true);
      expect(deps.launch).toHaveBeenCalledTimes(1);
      for (const filename of staleFiles) {
        await expect(fs.lstat(path.join(profileDir, filename))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("terminates one verified unreachable browser and relaunches in the same operation", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-repair-relaunch-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4800,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    deps.probe.mockImplementation(async ({ port }: { port: number }) =>
      state.running && state.pid === 4200 && port === state.port
        ? ({ ok: true } as const)
        : ({ ok: false, error: "offline" } as const),
    );
    const terminate = vi.fn(async () => {
      state.running = false;
      return {
        status: "complete" as const,
        pid: 4800,
        debugPort: 9333,
        method: "sigterm" as const,
        startedAt: "2026-08-30T04:00:00.000Z",
        completedAt: "2026-08-30T04:00:01.000Z",
        ownershipRevalidated: true,
        processExited: true,
        processFamilyPids: [4800],
        processFamilyExited: true,
        endpointClosed: true,
        metadataCleared: true,
      };
    });
    const release = vi.fn(async () => undefined);
    const acquireLock = vi.fn(async () => ({ path: "/tmp/lock", lockId: "lock", release }));
    try {
      const result = await acquireDedicatedChromeForRun(
        {
          profileDir,
          config: config(profileDir),
          logger: noopLogger,
          sessionId: "same-operation",
        },
        { ...deps, terminate, acquireLock },
      );

      expect(result.bootstrap).toMatchObject({
        action: "launch-current",
        repairAttempted: true,
        repairOutcome: "repaired-and-launched",
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(deps.launch).toHaveBeenCalledTimes(1);
      expect(acquireLock).toHaveBeenCalledWith(
        profileDir,
        expect.objectContaining({ sessionId: "same-operation" }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("stops after one repair when the managed browser state does not converge", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-repair-once-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4900,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    deps.probe.mockResolvedValue({ ok: false, error: "offline" } as const);
    const terminate = vi.fn(async () => ({
      status: "complete" as const,
      pid: state.pid,
      debugPort: state.port,
      method: "sigterm" as const,
      startedAt: "2026-08-30T04:00:00.000Z",
      completedAt: "2026-08-30T04:00:01.000Z",
      ownershipRevalidated: true,
      processExited: true,
      processFamilyPids: [state.pid],
      processFamilyExited: true,
      endpointClosed: true,
      metadataCleared: true,
    }));
    try {
      await expect(
        acquireDedicatedChromeForRun(
          {
            profileDir,
            config: config(profileDir),
            logger: noopLogger,
            sessionId: "repair-once",
          },
          { ...deps, terminate },
        ),
      ).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "dedicated-browser-repair-not-converged",
          promptSubmitted: false,
          externalDataSent: false,
        }),
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("preserves an unreachable managed browser when another consultation is recoverable", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-protected-repair-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4950,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    deps.probe.mockResolvedValue({ ok: false, error: "offline" } as const);
    const terminate = vi.fn();
    try {
      await expect(
        acquireDedicatedChromeForRun(
          {
            profileDir,
            config: config(profileDir),
            logger: noopLogger,
            sessionId: "new-operation",
            currentLeaseId: "current-lease",
          },
          {
            ...deps,
            terminate,
            processAlive: vi.fn(() => true),
            readRegistry: vi.fn(async () => ({
              version: 2 as const,
              leases: [
                {
                  id: "current-lease",
                  pid: process.pid,
                  sessionId: "new-operation",
                  ownerKind: "chatgpt" as const,
                  purpose: "browser-run",
                  createdAt: "2026-08-30T04:00:00.000Z",
                  updatedAt: "2026-08-30T04:00:00.000Z",
                },
              ],
              targets: [
                {
                  targetId: "recoverable-target",
                  ownerKind: "recovery" as const,
                  purpose: "session-reattach",
                  disposition: "recoverable" as const,
                  sessionId: "existing-operation",
                  recoveryExpiresAt: "2099-08-30T04:00:00.000Z",
                  createdAt: "2026-08-30T04:00:00.000Z",
                  updatedAt: "2026-08-30T04:00:00.000Z",
                },
              ],
            })),
          },
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("The new review was not sent"),
        details: expect.objectContaining({
          code: "dedicated-browser-protected",
          promptSubmitted: false,
          externalDataSent: false,
        }),
      });
      expect(terminate).not.toHaveBeenCalled();
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("does not terminate an unrelated live pid recorded in stale metadata", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-unrelated-pid-"));
    const state: ManagedProcessState = {
      running: false,
      pid: 0,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    const terminate = vi.fn();
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), `${process.pid}\n`);
      await fs.writeFile(path.join(profileDir, "SingletonLock"), "x");

      await acquireDedicatedChromeForRun(
        { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "unrelated" },
        {
          ...deps,
          observeProcess: vi.fn(async (pid: number) =>
            pid === process.pid
              ? {
                  pid,
                  command: `${process.execPath} unrelated-node-process`,
                  executablePath: process.execPath,
                  executableRealpath: process.execPath,
                  processStartTime: startTime,
                }
              : deps.observeProcess(pid),
          ),
          terminate,
        },
      );

      expect(terminate).not.toHaveBeenCalled();
      expect(deps.launch).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  test("fails closed when a runtime receipt conflicts with the live owner", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-conflict-"));
    const state: ManagedProcessState = {
      running: true,
      pid: 4700,
      port: 9333,
      executable: currentExecutable,
    };
    const deps = managedDeps(profileDir, state);
    try {
      await fs.writeFile(path.join(profileDir, "chrome.pid"), `${state.pid}\n`);
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), `${state.port}\n`);
      await writeRuntimeReceipt(profileDir, state, {
        processStartTime: "Sat Aug 30 11:00:00 2026",
      });

      await expect(
        acquireDedicatedChromeForRun(
          { profileDir, config: config(profileDir), logger: noopLogger, sessionId: "conflict" },
          deps,
        ),
      ).rejects.toMatchObject({
        details: expect.objectContaining({ code: "dedicated-browser-owner-unverified" }),
      });
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
