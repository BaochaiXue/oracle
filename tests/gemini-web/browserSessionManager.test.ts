import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const {
  launchChrome,
  connectWithNewTab,
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
  acquireBrowserTabLease,
  reconcileBrowserTargets,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTab: vi.fn(),
  readDevToolsPort: vi.fn(async () => null),
  writeDevToolsActivePort: vi.fn(async () => undefined),
  writeChromePid: vi.fn(async () => undefined),
  cleanupStaleProfileState: vi.fn(async () => undefined),
  verifyDevToolsReachable: vi.fn(async () => ({ ok: false, error: "unreachable" })),
  acquireBrowserTabLease: vi.fn(),
  reconcileBrowserTargets: vi.fn(async () => ({
    status: "complete",
    preservedTargetIds: [],
    closedTargetIds: [],
    skippedTargetIds: [],
    failedTargetIds: [],
  })),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  launchChrome,
  connectWithNewTab,
}));

vi.mock("../../src/browser/profileState.js", () => ({
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
}));

vi.mock("../../src/browser/tabLeaseRegistry.js", () => ({
  DEFAULT_MAX_CONCURRENT_CHATGPT_TABS: 3,
  normalizeMaxConcurrentTabs: (value: unknown) => Number(value ?? 3),
  acquireBrowserTabLease,
}));
vi.mock("../../src/browser/lifecycleReconciler.js", () => ({ reconcileBrowserTargets }));

describe("openGeminiBrowserSession", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-profile-"));
    delete process.env.ORACLE_BROWSER_PROFILE_DIR;

    launchChrome.mockReset();
    connectWithNewTab.mockReset();
    readDevToolsPort.mockReset();
    writeDevToolsActivePort.mockClear();
    writeChromePid.mockClear();
    cleanupStaleProfileState.mockClear();
    verifyDevToolsReachable.mockReset();
    acquireBrowserTabLease.mockReset();
    reconcileBrowserTargets.mockClear();

    launchChrome.mockResolvedValue({
      port: 9222,
      pid: 12345,
      kill: vi.fn(),
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-1",
      client: {
        close: vi.fn(async () => undefined),
      },
    });
    readDevToolsPort.mockResolvedValue(null);
    verifyDevToolsReachable.mockResolvedValue({ ok: false, error: "unreachable" });
    acquireBrowserTabLease.mockResolvedValue({
      id: "lease-1",
      update: vi.fn(async () => undefined),
      setTargetDisposition: vi.fn(async () => undefined),
      release: vi.fn(
        async (options?: { onRelease?: (state: { isLastLease: boolean }) => Promise<void> }) =>
          options?.onRelease?.({ isLastLease: true }),
      ),
    });
  });

  afterEach(async () => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prefers an explicit manual-login profile dir over the environment", async () => {
    const explicitDir = path.join(tempRoot, "explicit-profile");
    process.env.ORACLE_BROWSER_PROFILE_DIR = path.join(tempRoot, "env-profile");

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: explicitDir },
      keepBrowserDefault: false,
      purpose: "test",
    });

    expect(session.profileDir).toBe(explicitDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: explicitDir,
      }),
      explicitDir,
      expect.any(Function),
    );
  });

  it("uses ORACLE_BROWSER_PROFILE_DIR when no explicit profile dir is set", async () => {
    const envDir = path.join(tempRoot, "env-profile");
    process.env.ORACLE_BROWSER_PROFILE_DIR = envDir;

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: true,
      purpose: "test",
    });

    expect(session.profileDir).toBe(envDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        keepBrowser: true,
        manualLogin: true,
        manualLoginProfileDir: envDir,
      }),
      envDir,
      expect.any(Function),
    );
  });

  it("ignores blank environment profile dirs and falls back to the default", async () => {
    process.env.ORACLE_BROWSER_PROFILE_DIR = "   ";
    const homedir = path.join(tempRoot, "home");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homedir);
    const defaultDir = path.join(homedir, ".oracle", "browser-profile");

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: false,
      purpose: "test",
    });

    expect(session.profileDir).toBe(defaultDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: defaultDir,
      }),
      defaultDir,
      expect.any(Function),
    );
    homedirSpy.mockRestore();
  });

  it("closes a completed Gemini target while keepBrowser retains the Chrome process", async () => {
    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: tempRoot, keepBrowser: true },
      keepBrowserDefault: true,
      purpose: "deep-think",
      sessionId: "gemini-run",
    });
    await session.close({ disposition: "completed" });

    expect(reconcileBrowserTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profileDir: tempRoot,
        port: 9222,
        apply: true,
        ensureSentinel: true,
      }),
    );
    expect(launchChrome.mock.results[0]?.value).toBeDefined();
    expect(acquireBrowserTabLease).toHaveBeenCalledWith(
      tempRoot,
      expect.objectContaining({ ownerKind: "gemini", sessionId: "gemini-run" }),
    );
  });

  it("retains an incomplete Gemini target for recovery", async () => {
    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: tempRoot, keepBrowser: false },
      keepBrowserDefault: false,
      purpose: "deep-think",
      sessionId: "gemini-run",
    });
    await session.close({ disposition: "recoverable" });

    expect(reconcileBrowserTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({ apply: true, ensureSentinel: true }),
    );
    expect(cleanupStaleProfileState).not.toHaveBeenCalled();
  });
});
