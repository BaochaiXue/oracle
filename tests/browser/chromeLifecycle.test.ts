import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpListMock = vi.fn();
const cdpVersionMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Version: cdpVersionMock,
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe("registerTerminationHooks", () => {
  test("kills Chrome and removes a copied profile on an in-flight signal", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-signal-"));
    await writeFile(path.join(userDataDir, "Cookies"), "sensitive");
    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const emitRuntimeHint = vi.fn().mockResolvedValue(undefined);
    const previousExitCode = process.exitCode;
    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger,
      {
        isInFlight: () => true,
        emitRuntimeHint,
        forceProfileCleanup: true,
      },
    );

    try {
      process.emit("SIGTERM");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          await stat(userDataDir)
            .then(() => false)
            .catch(() => true)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(chrome.kill).toHaveBeenCalledTimes(1);
      expect(emitRuntimeHint).not.toHaveBeenCalled();
      await expect(stat(userDataDir)).rejects.toThrow();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("clears stale DevToolsActivePort hints when preserving userDataDir", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);

    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const logger = vi.fn();
    const userDataDir = "/tmp/oracle-manual-login-profile";

    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      logger,
      {
        isInFlight: () => false,
        preserveUserDataDir: true,
      },
    );

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));

    removeHooks();

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, { lockRemovalMode: "never" });
  });
});

describe("copied-profile launch flags", () => {
  test("strips mock keychain flags while retaining custom-host launch flags", async () => {
    const { resolveChromeLaunchOptionsForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const options = resolveChromeLaunchOptionsForTest(
      ["--use-mock-keychain", "--password-store=basic", "--remote-debugging-address=0.0.0.0"],
      true,
    );

    expect(options.ignoreDefaultFlags).toBe(true);
    expect(options.chromeFlags).not.toContain("--use-mock-keychain");
    expect(options.chromeFlags).not.toContain("--password-store=basic");
    expect(options.chromeFlags).toContain("--remote-debugging-address=0.0.0.0");
  });
});

describe("persistent-profile launch flags", () => {
  test("resolves the dedicated executable to its macOS app bundle", async () => {
    const { __macLaunchTest__ } = await import("../../src/browser/chromeLifecycle.js");

    expect(
      __macLaunchTest__.resolveMacAppBundle(
        "/tmp/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    ).toBe("/tmp/Google Chrome for Testing.app");
    expect(__macLaunchTest__.resolveMacAppBundle("/usr/bin/chromium")).toBeNull();
  });

  test("keeps long Pro turns live without dropping persistent-profile safeguards", async () => {
    const { buildChromeFlagsForTest, resolveChromeLaunchOptionsForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const flags = buildChromeFlagsForTest(false, "127.0.0.1", false, true);
    const options = resolveChromeLaunchOptionsForTest(flags, false, true);

    expect(options.ignoreDefaultFlags).toBe(true);
    expect(options.chromeFlags).toContain("--remote-debugging-address=127.0.0.1");
    expect(options.chromeFlags).toContain("--disable-extensions");
    expect(options.chromeFlags).toContain("--disable-backgrounding-occluded-windows");
    expect(options.chromeFlags).not.toContain("--disable-background-timer-throttling");
    expect(options.chromeFlags).not.toContain("--disable-renderer-backgrounding");
    expect(options.chromeFlags).not.toContain("--disable-hang-monitor");
    expect(options.chromeFlags).not.toContain("--disable-ipc-flooding-protection");
    expect(options.chromeFlags).not.toContain("--safebrowsing-disable-auto-update");
    expect(options.chromeFlags).not.toContain("--use-mock-keychain");
    expect(options.chromeFlags).not.toContain("--password-store=basic");
  });

  test("can opt a persistent macOS profile into the non-interactive mock keychain", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");
    const flags = buildChromeFlagsForTest(false, "127.0.0.1", false, true, true);

    if (process.platform === "darwin") {
      expect(flags).toContain("--use-mock-keychain");
      expect(flags).not.toContain("--password-store=basic");
    } else {
      expect(flags).not.toContain("--use-mock-keychain");
    }
  });
});

describe("hidden-window launch flags", () => {
  test("keeps macOS Chrome rendered in an off-screen window", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");
    const flags = buildChromeFlagsForTest(false, undefined, true);

    if (process.platform === "darwin") {
      expect(flags).toContain("--window-position=-32000,-32000");
    } else {
      expect(flags).not.toContain("--window-position=-32000,-32000");
    }
  });

  test("does not add a window position to headless Chrome", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");

    expect(buildChromeFlagsForTest(true, undefined, true)).not.toContain(
      "--window-position=-32000,-32000",
    );
  });

  test("adds no-sandbox flags only when ORACLE_CHROME_NO_SANDBOX=1", async () => {
    const { buildChromeFlagsForTest } = await import("../../src/browser/chromeLifecycle.js");
    const previous = process.env.ORACLE_CHROME_NO_SANDBOX;
    try {
      delete process.env.ORACLE_CHROME_NO_SANDBOX;
      expect(buildChromeFlagsForTest(false)).not.toContain("--no-sandbox");
      process.env.ORACLE_CHROME_NO_SANDBOX = "1";
      const flags = buildChromeFlagsForTest(false);
      expect(flags).toContain("--no-sandbox");
      expect(flags).toContain("--disable-dev-shm-usage");
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_CHROME_NO_SANDBOX;
      } else {
        process.env.ORACLE_CHROME_NO_SANDBOX = previous;
      }
    }
  });

  test("moves a running macOS Chrome window without minimizing it", async () => {
    const { positionChromeWindowOffscreen } = await import("../../src/browser/chromeLifecycle.js");
    const browser = {
      getWindowForTarget: vi.fn().mockResolvedValue({ windowId: 7 }),
      setWindowBounds: vi.fn().mockResolvedValue(undefined),
    };
    const logger = vi.fn();

    await positionChromeWindowOffscreen({ Browser: browser } as never, logger as never);

    if (process.platform === "darwin") {
      expect(browser.setWindowBounds).toHaveBeenCalledWith({
        windowId: 7,
        bounds: { left: -32_000, top: -32_000, windowState: "normal" },
      });
    } else {
      expect(browser.setWindowBounds).not.toHaveBeenCalled();
    }
  });

  test("restores a visible Oracle window to an on-screen macOS position", async () => {
    const { positionChromeWindowOnscreen } = await import("../../src/browser/chromeLifecycle.js");
    const browser = {
      getWindowForTarget: vi.fn().mockResolvedValue({
        windowId: 9,
        bounds: { left: -32_000, top: -32_000, width: 1280, height: 720 },
      }),
      getWindowBounds: vi.fn(),
      setWindowBounds: vi.fn().mockResolvedValue(undefined),
    };
    const logger = vi.fn();

    await positionChromeWindowOnscreen({ Browser: browser } as never, logger as never);

    if (process.platform === "darwin") {
      expect(browser.setWindowBounds).toHaveBeenCalledWith({
        windowId: 9,
        bounds: { left: 80, top: 80, width: 1280, height: 720, windowState: "normal" },
      });
    } else {
      expect(browser.setWindowBounds).not.toHaveBeenCalled();
    }
  });

  test("preserves a user-positioned visible Oracle window", async () => {
    const { positionChromeWindowOnscreen } = await import("../../src/browser/chromeLifecycle.js");
    const browser = {
      getWindowForTarget: vi.fn().mockResolvedValue({
        windowId: 11,
        bounds: { left: -1440, top: 120, width: 1280, height: 720 },
      }),
      getWindowBounds: vi.fn(),
      setWindowBounds: vi.fn().mockResolvedValue(undefined),
    };

    await positionChromeWindowOnscreen({ Browser: browser } as never, vi.fn() as never);

    expect(browser.setWindowBounds).not.toHaveBeenCalled();
  });
});

describe("connectWithNewTab", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
    cdpVersionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("falls back to default target when new tab cannot be opened", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open isolated browser tab"),
    );
  });

  test("closes unused tab when attach fails", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-1" });
    cdpMock.mockRejectedValueOnce(new Error("attach fail")).mockResolvedValueOnce({});
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, id: "target-1" });
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to attach to isolated browser tab"),
    );
  });

  test("throws when strict mode disallows fallback", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await expect(
      connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false }),
    ).rejects.toThrow(/isolated browser tab/i);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("returns isolated target when attach succeeds", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-2" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("target-2");
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-2" });
  });

  test("opens a visible dedicated tab without changing window focus", async () => {
    const send = vi.fn(async (method: string) =>
      method === "Target.createTarget" ? { targetId: "target-safe" } : {},
    );
    const browserClient = {
      send,
      Target: {
        attachToTarget: vi.fn(async () => ({ sessionId: "session-safe" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: {},
      Page: {},
      Runtime: {},
      Input: {},
      DOM: {},
      Emulation: {},
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    cdpVersionMock.mockResolvedValue({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/safe",
    });
    cdpMock.mockResolvedValue(browserClient);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const result = await connectWithNewTab(
      9222,
      vi.fn<(message: string) => void>(),
      "about:blank",
      "127.0.0.1",
      {
        fallbackToDefault: false,
        preserveWindowFocus: true,
      },
    );

    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Target.createTarget", {
      url: "about:blank",
      background: false,
      focus: false,
    });
    expect(browserClient.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "target-safe",
      flatten: true,
    });
    expect(result.targetId).toBe("target-safe");
    await result.client.close();
    expect(browserClient.Target.detachFromTarget).toHaveBeenCalledWith({
      sessionId: "session-safe",
    });
    expect(browserClient.close).toHaveBeenCalledTimes(1);
  });

  test("retries transient DevTools connection failures before falling back", async () => {
    vi.useFakeTimers();
    cdpNewMock
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:9222"))
      .mockResolvedValueOnce({ id: "target-3" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const resultPromise = connectWithNewTab(9222, logger, undefined, undefined, {
      retries: 1,
      retryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.targetId).toBe("target-3");
    expect(cdpNewMock).toHaveBeenCalledTimes(2);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-3" });
  });
});

describe("remote Chrome target connections", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
    cdpVersionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens a dedicated tab through a browser websocket endpoint", async () => {
    const send = vi.fn(async (method: string) =>
      method === "Target.createTarget" ? { targetId: "target-9" } : {},
    );
    const browserClient = {
      Target: {
        attachToTarget: vi.fn(async () => ({ sessionId: "session-9" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      Emulation: { setFocusEmulationEnabled: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    Object.defineProperty(browserClient, "send", { value: send });
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );

    expect(cdpMock).toHaveBeenCalledWith({
      target: "ws://127.0.0.1:9222/devtools/browser/abc",
      local: true,
    });
    expect(send).toHaveBeenCalledWith("Target.createTarget", {
      url: "https://chatgpt.com/",
      background: false,
      focus: false,
    });
    expect(browserClient.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "target-9",
      flatten: true,
    });
    expect(connection.targetId).toBe("target-9");
    await connection.client.Emulation.setFocusEmulationEnabled({ enabled: true });
    expect(browserClient.Emulation.setFocusEmulationEnabled).toHaveBeenCalledWith(
      { enabled: true },
      "session-9",
    );
    await (
      connection.client as typeof connection.client & {
        send: (method: string, params: unknown, sessionId: string) => Promise<unknown>;
      }
    ).send("Target.setAutoAttach", { autoAttach: true }, "session-9");
    expect(send).toHaveBeenCalledWith("Target.setAutoAttach", { autoAttach: true }, "session-9");
  });

  test("waits on a single websocket connection attempt for Chrome approval", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (method: string) =>
      method === "Target.createTarget" ? { targetId: "target-10" } : {},
    );
    const browserClient = {
      send,
      Target: {
        attachToTarget: vi.fn(async () => ({ sessionId: "session-10" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(browserClient), 1_000);
        }),
    );

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
    expect(connection.targetId).toBe("target-10");
  });

  test("fails after the approval wait without opening a second websocket request", async () => {
    vi.useFakeTimers();
    cdpMock.mockImplementationOnce(() => new Promise(() => {}));

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );
    const assertion = expect(promise).rejects.toThrow(
      /waited 20s for Chrome remote debugging approval/i,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
  });

  test("retries immediate 403 responses while waiting for remote debugging approval", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (method: string) =>
      method === "Target.createTarget" ? { targetId: "target-20" } : {},
    );
    const browserClient = {
      send,
      Target: {
        attachToTarget: vi.fn(async () => ({ sessionId: "session-20" })),
      },
      close: vi.fn(async () => {}),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    };
    cdpMock
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockResolvedValueOnce(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(3);
    expect(connection.targetId).toBe("target-20");
  });
});

describe("ensureChromePageTargetAfterClose", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpListMock.mockReset();
    cdpVersionMock.mockReset();
  });

  function mockFocusSafeReplacement(targetId: string): {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn(async (method: string) =>
      method === "Target.createTarget" ? { targetId } : {},
    );
    const close = vi.fn(async () => undefined);
    cdpVersionMock.mockResolvedValue({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/replacement",
    });
    cdpMock.mockResolvedValue({ send, close });
    return { send, close };
  }

  test("reuses another page instead of opening a replacement", async () => {
    cdpListMock.mockResolvedValue([
      { id: "run-target", type: "page" },
      { id: "other-target", type: "page" },
    ]);
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("other-target");
    expect(cdpNewMock).not.toHaveBeenCalled();
  });

  test("opens a replacement when the completed run owns the only page", async () => {
    cdpListMock.mockResolvedValue([{ id: "run-target", type: "page" }]);
    const browser = mockFocusSafeReplacement("replacement-target");
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-target");
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(browser.send).toHaveBeenCalledWith("Target.createTarget", {
      url: "about:blank",
      background: false,
      focus: false,
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test("reuses a replacement created by an earlier serialized cleanup", async () => {
    cdpListMock.mockResolvedValueOnce([{ id: "run-a", type: "page" }]).mockResolvedValueOnce([
      { id: "run-b", type: "page" },
      { id: "replacement-a", type: "page" },
    ]);
    const browser = mockFocusSafeReplacement("replacement-a");
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-a",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-a");
    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-b",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBe("replacement-a");
    expect(browser.send).toHaveBeenCalledTimes(1);
  });

  test("fails closed when a replacement cannot be opened", async () => {
    cdpListMock.mockResolvedValue([{ id: "run-target", type: "page" }]);
    cdpVersionMock.mockRejectedValue(new Error("cannot create"));
    const { ensureChromePageTargetAfterClose } =
      await import("../../src/browser/chromeLifecycle.js");

    await expect(
      ensureChromePageTargetAfterClose(
        9222,
        "run-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("closeTab", () => {
  beforeEach(() => {
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  test("waits for the closed target to disappear", async () => {
    cdpCloseMock.mockResolvedValue(undefined);
    cdpListMock
      .mockResolvedValueOnce([{ id: "closing-target", type: "page" }])
      .mockResolvedValueOnce([{ id: "retained-target", type: "page" }]);
    const { closeTab } = await import("../../src/browser/chromeLifecycle.js");

    await expect(
      closeTab(9222, "closing-target", vi.fn<(message: string) => void>(), "127.0.0.1"),
    ).resolves.toBe(true);

    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "closing-target",
    });
    expect(cdpListMock).toHaveBeenCalledTimes(2);
  });

  test("reports an unconfirmed close when the target never disappears", async () => {
    vi.useFakeTimers();
    try {
      cdpCloseMock.mockResolvedValue(undefined);
      cdpListMock.mockResolvedValue([{ id: "closing-target", type: "page" }]);
      const { closeTab } = await import("../../src/browser/chromeLifecycle.js");

      const closePromise = closeTab(
        9222,
        "closing-target",
        vi.fn<(message: string) => void>(),
        "127.0.0.1",
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(closePromise).resolves.toBe(false);
      expect(cdpListMock).toHaveBeenCalledTimes(40);
    } finally {
      vi.useRealTimers();
    }
  });
});
