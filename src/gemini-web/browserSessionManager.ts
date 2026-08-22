import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import { launchChrome, connectWithNewTab } from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} from "../browser/profileState.js";
import { acquireBrowserTabLease, type BrowserTabLease } from "../browser/tabLeaseRegistry.js";
import { reconcileBrowserTargets } from "../browser/lifecycleReconciler.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  updateTabUrl: (url: string) => Promise<void>;
  close: (options: { disposition: "completed" | "recoverable" }) => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  sessionId?: string;
  log?: BrowserLogger;
  runtimeHintCb?: BrowserRunOptions["runtimeHintCb"];
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log } = input;
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  await mkdir(profileDir, { recursive: true });
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);

  let port = await readDevToolsPort(profileDir);
  let launchedChrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let chromeWasLaunched = false;
  let openedTargetId: string | undefined;
  let openedPort: number | undefined;
  let openedTabUrl = "about:blank";
  let lease: BrowserTabLease | null = await acquireBrowserTabLease(profileDir, {
    maxConcurrentTabs: resolvedConfig.maxConcurrentTabs,
    timeoutMs: resolvedConfig.timeoutMs,
    logger: log,
    sessionId: input.sessionId,
    ownerKind: "gemini",
    purpose,
  });

  try {
    if (port) {
      const probe = await verifyDevToolsReachable({ port });
      if (!probe.ok) {
        log?.(`[gemini-web] Stale DevTools port ${port}; launching fresh Chrome for ${purpose}.`);
        await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "if_oracle_pid_dead" });
        port = null;
      }
    }

    if (!port) {
      log?.(`[gemini-web] Launching Chrome for ${purpose}.`);
      launchedChrome = await launchChrome(resolvedConfig, profileDir, log ?? (() => {}));
      port = launchedChrome.port;
      chromeWasLaunched = true;
      await writeDevToolsActivePort(profileDir, port);
      if (launchedChrome.pid) {
        await writeChromePid(profileDir, launchedChrome.pid);
      }
    } else {
      log?.(`[gemini-web] Reusing Chrome on port ${port} for ${purpose}.`);
    }

    const activePort = port;
    openedPort = activePort;
    const startupReceipt = await reconcileBrowserTargets({
      profileDir,
      host: "127.0.0.1",
      port: activePort,
      logger: log ?? (() => {}),
      apply: true,
      ensureSentinel: true,
    });
    if (startupReceipt.status !== "complete") {
      log?.(
        `[gemini-web] Startup target reconciliation ${startupReceipt.status}; retry remains durable.`,
      );
    }

    await lease.update({ chromeHost: "127.0.0.1", chromePort: activePort });
    const connection = await connectWithNewTab(
      activePort,
      log ?? (() => {}),
      undefined,
      undefined,
      {
        fallbackToDefault: false,
        retries: 6,
        retryDelayMs: 500,
        preserveWindowFocus: true,
      },
    );
    const client = connection.client;
    const targetId = connection.targetId;
    openedTargetId = targetId;
    let currentTabUrl = openedTabUrl;
    if (targetId) {
      await lease.update({
        chromeHost: "127.0.0.1",
        chromePort: activePort,
        chromeTargetId: targetId,
        tabUrl: currentTabUrl,
        ownsTarget: true,
      });
    }
    await input.runtimeHintCb?.({
      browserTransport: "cdp",
      chromePid: launchedChrome?.pid,
      chromePort: activePort,
      chromeHost: "127.0.0.1",
      userDataDir: profileDir,
      chromeTargetId: targetId,
      tabUrl: currentTabUrl,
      browserDisposition: "active",
      controllerPid: process.pid,
    });

    const updateTabUrl = async (url: string): Promise<void> => {
      currentTabUrl = url;
      openedTabUrl = url;
      await lease?.update({ tabUrl: url });
      await input.runtimeHintCb?.({
        browserTransport: "cdp",
        chromePid: launchedChrome?.pid,
        chromePort: activePort,
        chromeHost: "127.0.0.1",
        userDataDir: profileDir,
        chromeTargetId: targetId,
        tabUrl: currentTabUrl,
        browserDisposition: "active",
        controllerPid: process.pid,
      });
    };

    const close = async (options: { disposition: "completed" | "recoverable" }): Promise<void> => {
      const completed = options.disposition === "completed";
      const recoveryExpiresAt = completed
        ? undefined
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      await lease?.setTargetDisposition(completed ? "terminal" : "recoverable", {
        recoveryKind: completed ? undefined : "awaiting-response",
        recoveryExpiresAt,
      });
      await input.runtimeHintCb?.({
        browserTransport: "cdp",
        chromePid: launchedChrome?.pid,
        chromePort: activePort,
        chromeHost: "127.0.0.1",
        userDataDir: profileDir,
        chromeTargetId: targetId,
        tabUrl: targetId ? currentTabUrl : undefined,
        browserDisposition: completed ? "completed" : "recoverable",
        recoveryKind: completed ? undefined : "awaiting-response",
        recoveryExpiresAt,
        controllerPid: process.pid,
      });
      const handle = lease;
      lease = null;
      let reconciliationFailed = false;
      let releaseError: unknown;
      try {
        await handle?.release({
          onRelease: async () => {
            const receipt = await reconcileBrowserTargets({
              profileDir,
              host: "127.0.0.1",
              port: activePort,
              logger: log ?? (() => {}),
              apply: true,
              ensureSentinel: keepBrowser || !completed,
            });
            reconciliationFailed = reconciliationFailed || receipt.status !== "complete";
          },
        });
      } catch (error) {
        reconciliationFailed = true;
        releaseError = error;
      }
      if (reconciliationFailed) {
        await input.runtimeHintCb?.({
          browserTransport: "cdp",
          chromePid: launchedChrome?.pid,
          chromePort: activePort,
          chromeHost: "127.0.0.1",
          userDataDir: profileDir,
          chromeTargetId: targetId,
          browserDisposition: completed ? "completed" : "recoverable",
          recoveryKind: completed ? undefined : "awaiting-response",
          recoveryExpiresAt,
          reconcileNeeded: true,
          controllerPid: process.pid,
        });
      }
      if (releaseError) throw releaseError;

      if (
        completed &&
        !keepBrowser &&
        !reconciliationFailed &&
        chromeWasLaunched &&
        launchedChrome
      ) {
        launchedChrome.kill();
        await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "never" });
      }
    };

    return {
      profileDir,
      port: activePort,
      client,
      targetId: targetId ?? undefined,
      updateTabUrl,
      close,
    };
  } catch (error) {
    const handle = lease;
    if (openedTargetId) {
      await handle?.setTargetDisposition("recoverable", {
        recoveryKind: "awaiting-response",
        recoveryExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      await input.runtimeHintCb?.({
        browserTransport: "cdp",
        chromePid: launchedChrome?.pid,
        chromePort: openedPort,
        chromeHost: "127.0.0.1",
        userDataDir: profileDir,
        chromeTargetId: openedTargetId,
        tabUrl: openedTabUrl,
        browserDisposition: "recoverable",
        recoveryKind: "awaiting-response",
        recoveryExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        reconcileNeeded: true,
        controllerPid: process.pid,
      });
    }
    lease = null;
    await handle?.release({
      onRelease: async () => {
        if (!openedPort) return;
        await reconcileBrowserTargets({
          profileDir,
          host: "127.0.0.1",
          port: openedPort,
          logger: log ?? (() => {}),
          apply: true,
          ensureSentinel: true,
        });
      },
    });
    if (!openedTargetId && chromeWasLaunched && launchedChrome && !keepBrowser) {
      launchedChrome.kill();
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "never" });
    }
    throw error;
  }
}
