import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearDedicatedChromeMetadata,
  classifyDedicatedChromeOwnership,
  inspectDedicatedChromeState,
  planDedicatedChromeAction,
  terminateVerifiedDedicatedChrome,
  writeDedicatedBrowserRuntimeReceipt,
  type DedicatedBrowserRuntimeReceipt,
  type ObservedProcess,
} from "../../src/browser/dedicatedChromeSupervisor.js";

const profileRealpath = "/Users/example/.oracle/browser-profile";
const currentExecutable =
  "/Users/example/.oracle/browsers/chrome/140/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const oldExecutable =
  "/Users/example/.oracle/browsers/chrome/139/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function observed(overrides: Partial<ObservedProcess> = {}): ObservedProcess {
  return {
    pid: 4100,
    ppid: 1,
    command: `${currentExecutable} --user-data-dir=${profileRealpath} --remote-debugging-port=9333`,
    executablePath: currentExecutable,
    executableRealpath: currentExecutable,
    processStartTime: "Sat Aug 30 12:00:00 2026",
    ...overrides,
  };
}

function receipt(overrides: Partial<DedicatedBrowserRuntimeReceipt> = {}) {
  return {
    version: 1 as const,
    pid: 4100,
    processStartTime: "Sat Aug 30 12:00:00 2026",
    profileRealpath,
    executableRealpath: currentExecutable,
    platform: "darwin",
    debugHost: "127.0.0.1" as const,
    debugPort: 9333,
    launchedAt: "2026-08-30T04:00:00.000Z",
    lastVerifiedAt: "2026-08-30T04:00:01.000Z",
    ...overrides,
  };
}

describe("dedicated Chrome ownership", () => {
  test("classifies the configured generation as managed-current", () => {
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed(),
        profileRealpath,
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable, oldExecutable],
        receipt: receipt(),
      }),
    ).toBe("managed-current");
  });

  test("accepts canonical executable and profile aliases without weakening exact matching", () => {
    const profileAlias = "/Users/example/oracle-profile-link";
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed({
          command: `/Users/example/oracle-cft-link --user-data-dir=${profileAlias} --remote-debugging-port=9333`,
          executablePath: "/Users/example/oracle-cft-link",
          executableRealpath: currentExecutable,
        }),
        profileRealpath,
        profilePathAliases: [profileAlias],
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable],
        receipt: null,
      }),
    ).toBe("managed-current");
  });

  test("classifies an installed old generation as managed-compatible", () => {
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed({
          command: `${oldExecutable} --user-data-dir=${profileRealpath} --remote-debugging-port=9333`,
          executablePath: oldExecutable,
          executableRealpath: oldExecutable,
        }),
        profileRealpath,
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable, oldExecutable],
        receipt: receipt({ executableRealpath: oldExecutable }),
      }),
    ).toBe("managed-compatible");
  });

  test("accepts a deleted old generation only when the live process matches its receipt", () => {
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed({
          command: `${oldExecutable} --user-data-dir=${profileRealpath} --remote-debugging-port=9333`,
          executablePath: oldExecutable,
          executableRealpath: undefined,
        }),
        profileRealpath,
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable],
        receipt: receipt({ executableRealpath: oldExecutable }),
      }),
    ).toBe("managed-compatible");
  });

  test("rejects everyday Chrome even when it uses the dedicated profile", () => {
    const everyday = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed({
          command: `${everyday} --user-data-dir=${profileRealpath} --remote-debugging-port=9333`,
          executablePath: everyday,
          executableRealpath: everyday,
        }),
        profileRealpath,
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable, oldExecutable],
        receipt: null,
      }),
    ).toBe("foreign-or-ambiguous");
  });

  test("rejects foreign Chromium and profile or port prefix collisions", () => {
    const foreign = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    for (const command of [
      `${foreign} --user-data-dir=${profileRealpath} --remote-debugging-port=9333`,
      `${currentExecutable} --user-data-dir=${profileRealpath}-other --remote-debugging-port=9333`,
      `${currentExecutable} --user-data-dir=${profileRealpath} --remote-debugging-port=93330`,
    ]) {
      expect(
        classifyDedicatedChromeOwnership({
          observed: observed({
            command,
            executablePath: command.startsWith(foreign) ? foreign : currentExecutable,
            executableRealpath: command.startsWith(foreign) ? foreign : currentExecutable,
          }),
          profileRealpath,
          debugPort: 9333,
          configuredExecutableRealpath: currentExecutable,
          installedExecutableRealpaths: [currentExecutable],
          receipt: null,
        }),
      ).toBe("foreign-or-ambiguous");
    }
  });

  test("rejects a receipt whose process start time conflicts with the live process", () => {
    expect(
      classifyDedicatedChromeOwnership({
        observed: observed(),
        profileRealpath,
        debugPort: 9333,
        configuredExecutableRealpath: currentExecutable,
        installedExecutableRealpaths: [currentExecutable],
        receipt: receipt({ processStartTime: "Sat Aug 30 11:00:00 2026" }),
      }),
    ).toBe("foreign-or-ambiguous");
  });
});

describe("dedicated Chrome action planner", () => {
  test.each([
    ["absent", "acquire", "launch-current"],
    ["stale-metadata", "acquire", "clear-stale-metadata-and-launch"],
    ["healthy-current", "acquire", "reuse-current"],
    ["healthy-managed-compatible", "acquire", "reuse-compatible-and-defer-rollover"],
    ["unreachable-managed", "acquire", "terminate-managed-and-launch-current"],
    ["orphan-managed", "acquire", "terminate-managed-and-launch-current"],
    ["ambiguous", "acquire", "block-human-action"],
    ["healthy-current", "drain", "terminate-managed"],
    ["healthy-managed-compatible", "heal", "terminate-managed"],
    ["stale-metadata", "heal", "clear-stale-metadata"],
  ] as const)("maps %s in %s mode to %s", (state, mode, action) => {
    expect(planDedicatedChromeAction({ state, mode, protectedState: false }).action).toBe(action);
  });

  test("never terminates a protected managed browser", () => {
    expect(
      planDedicatedChromeAction({
        state: "unreachable-managed",
        mode: "heal",
        protectedState: true,
      }).action,
    ).toBe("preserve-protected");
  });

  test("reuses healthy generations but preserves protected work before destructive acquire repair", () => {
    expect(
      planDedicatedChromeAction({
        state: "healthy-managed-compatible",
        mode: "acquire",
        protectedState: true,
      }).action,
    ).toBe("reuse-compatible-and-defer-rollover");
    expect(
      planDedicatedChromeAction({
        state: "unreachable-managed",
        mode: "acquire",
        protectedState: true,
      }).action,
    ).toBe("preserve-protected");
  });
});

describe("verified dedicated Chrome termination", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function harness() {
    let running = true;
    let liveStartTime = "Sat Aug 30 12:00:00 2026";
    const runtimeReceipt = receipt();
    const clearMetadata = vi.fn(async () => undefined);
    const deps = {
      resolveExecutable: vi.fn(async () => currentExecutable),
      listInstalled: vi.fn(async () => [
        { buildId: "140", platform: "mac", executablePath: currentExecutable },
      ]),
      readReceipt: vi.fn(async () => runtimeReceipt),
      readPid: vi.fn(async () => 4100),
      readPort: vi.fn(async () => 9333),
      findProfileProcess: vi.fn(async () => (running ? { pid: 4100, port: 9333 } : null)),
      observeProcess: vi.fn(async () =>
        running ? observed({ processStartTime: liveStartTime }) : null,
      ),
      probe: vi.fn(async () =>
        running ? ({ ok: true } as const) : ({ ok: false, error: "offline" } as const),
      ),
      alive: vi.fn(() => running),
      clearMetadata,
      wait: vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      }),
    };
    const inspection = await inspectDedicatedChromeState(
      { profileDir: profileRealpath, chromePath: currentExecutable },
      deps,
    );
    return {
      deps,
      inspection,
      stop: () => {
        running = false;
      },
      changeStartTime: () => {
        liveStartTime = "Sat Aug 30 12:01:00 2026";
      },
      isRunning: () => running,
    };
  }

  test("prefers CDP Browser.close and clears metadata only after confirmed exit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
    const state = await harness();
    const closeOverCdp = vi.fn(async () => state.stop());

    const result = await terminateVerifiedDedicatedChrome(
      { inspection: state.inspection },
      { ...state.deps, closeOverCdp },
    );

    expect(result).toMatchObject({
      status: "complete",
      method: "cdp",
      processExited: true,
      endpointClosed: true,
      metadataCleared: true,
    });
    expect(state.deps.clearMetadata).toHaveBeenCalledTimes(1);
  });

  test("falls back from CDP close to SIGTERM", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
    const state = await harness();
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") state.stop();
    });

    const result = await terminateVerifiedDedicatedChrome(
      { inspection: state.inspection },
      {
        ...state.deps,
        closeOverCdp: vi.fn(async () => {
          throw new Error("cdp unavailable");
        }),
        sendSignal,
      },
    );

    expect(result.status).toBe("complete");
    expect(result.method).toBe("sigterm");
    expect(sendSignal).toHaveBeenCalledWith(4100, "SIGTERM");
  });

  test("uses SIGKILL only after ownership revalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
    const state = await harness();
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") state.stop();
    });

    const result = await terminateVerifiedDedicatedChrome(
      { inspection: state.inspection },
      {
        ...state.deps,
        closeOverCdp: vi.fn(async () => {
          throw new Error("cdp unavailable");
        }),
        sendSignal,
      },
    );

    expect(result.status).toBe("complete");
    expect(result.method).toBe("sigkill");
    expect(sendSignal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("does not report success until the captured Chrome process family exits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
    const state = await harness();
    let rootRunning = true;
    let helperRunning = true;
    const helperStartTime = "Sat Aug 30 12:00:01 2026";
    const alive = vi.fn((pid: number) =>
      pid === 4100 ? rootRunning : pid === 4101 ? helperRunning : false,
    );
    const observeProcess = vi.fn(async (pid: number) => {
      if (pid === 4100 && rootRunning) return observed();
      if (pid === 4101 && helperRunning) {
        return {
          pid,
          ppid: 4100,
          command: `${currentExecutable} --type=renderer`,
          processStartTime: helperStartTime,
        };
      }
      return null;
    });
    const sendSignal = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 4101 && signal === "SIGTERM") helperRunning = false;
      if (pid === 4100) rootRunning = false;
    });

    const result = await terminateVerifiedDedicatedChrome(
      { inspection: state.inspection },
      {
        ...state.deps,
        listProcesses: vi.fn(async () => [
          observed(),
          {
            pid: 4101,
            ppid: 4100,
            command: `${currentExecutable} --type=renderer`,
            processStartTime: helperStartTime,
          },
        ]),
        alive,
        observeProcess,
        probe: vi.fn(async () =>
          rootRunning ? ({ ok: true } as const) : ({ ok: false, error: "offline" } as const),
        ),
        closeOverCdp: vi.fn(async () => {
          rootRunning = false;
        }),
        sendSignal,
      },
    );

    expect(result).toMatchObject({
      status: "complete",
      method: "sigterm",
      processExited: true,
      processFamilyPids: [4100, 4101],
      processFamilyExited: true,
      endpointClosed: true,
      metadataCleared: true,
    });
    expect(sendSignal).toHaveBeenCalledWith(4101, "SIGTERM");
  });

  test("stops escalation when process identity changes before SIGKILL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T04:00:00.000Z"));
    const state = await harness();
    const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") state.changeStartTime();
    });

    const result = await terminateVerifiedDedicatedChrome(
      { inspection: state.inspection },
      {
        ...state.deps,
        closeOverCdp: vi.fn(async () => {
          throw new Error("cdp unavailable");
        }),
        sendSignal,
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.error).toContain("before SIGKILL");
    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(state.deps.clearMetadata).not.toHaveBeenCalled();
    expect(state.isRunning()).toBe(true);
  });
});

describe("dedicated Chrome runtime metadata", () => {
  test("writes an owner-only receipt and never removes persistent profile data", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-receipt-"));
    try {
      const defaultDir = path.join(profileDir, "Default");
      await fs.mkdir(defaultDir, { recursive: true });
      const cookiesPath = path.join(defaultDir, "Cookies");
      await fs.writeFile(cookiesPath, "persistent-login-data");
      await fs.writeFile(path.join(profileDir, "chrome.pid"), "4100\n");
      await fs.writeFile(path.join(profileDir, "DevToolsActivePort"), "9333\n");
      const runtimeReceipt = receipt({ profileRealpath: await fs.realpath(profileDir) });

      await writeDedicatedBrowserRuntimeReceipt(profileDir, runtimeReceipt);
      const receiptPath = path.join(profileDir, "oracle-browser-runtime.json");
      if (process.platform !== "win32") {
        expect((await fs.stat(receiptPath)).mode & 0o777).toBe(0o600);
      }

      await clearDedicatedChromeMetadata(profileDir);

      await expect(fs.readFile(cookiesPath, "utf8")).resolves.toBe("persistent-login-data");
      await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(profileDir, "chrome.pid"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });
});
