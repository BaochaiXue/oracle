import { spawn } from "node:child_process";
import type { LaunchedChrome } from "chrome-launcher";
import { Launcher } from "chrome-launcher";
import { CHATGPT_URL } from "../browser/constants.js";
import {
  connectToChrome,
  launchChrome,
  positionChromeWindowOffscreen,
} from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { resolveDedicatedBrowserExecutable } from "../browser/dedicatedBrowserBinary.js";
import {
  assertManualLoginProfileReadyForRun,
  ensureDedicatedBrowserProfileDirectory,
} from "../browser/manualLoginProfile.js";
import {
  ensureLoggedIn,
  ensureNotBlocked,
  ensurePromptReady,
  navigateToChatGPT,
} from "../browser/pageActions.js";
import {
  cleanupStaleProfileState,
  findRunningChromeForProfile,
  verifyDevToolsReachable,
} from "../browser/profileState.js";
import type { BrowserLogger, ChromeClient } from "../browser/types.js";
import { delay } from "../browser/utils.js";

export interface DedicatedBrowserSetupOptions {
  profileDir: string;
  chromePath?: string;
  useMockKeychain?: boolean;
  json?: boolean;
  verbose?: boolean;
  onStarted?: (receipt: { profileDir: string; pid?: number }) => void;
}

export interface DedicatedBrowserSmokeOptions extends DedicatedBrowserSetupOptions {
  port: number;
  visible?: boolean;
}

interface DedicatedBrowserSmokeCycle {
  cycle: number;
  pid?: number;
  port: number;
  host: "127.0.0.1";
  pageHost: string;
  authenticated: true;
  promptReady: true;
  promptSubmitted: false;
  elapsedMs: number;
}

export interface DedicatedBrowserSmokeResult {
  ok: true;
  transport: "direct-cdp";
  profileDir: string;
  keychainMode: "mock" | "system";
  coldStarts: 2;
  recurringApprovalRequired: false;
  promptSubmitted: false;
  cycles: DedicatedBrowserSmokeCycle[];
}

function createLogger(verbose = false): BrowserLogger {
  const logger = ((message: string) => {
    if (verbose) process.stderr.write(`[oracle-browser] ${message}\n`);
  }) as BrowserLogger;
  logger.verbose = verbose;
  return logger;
}

function resolveDedicatedConfig(options: DedicatedBrowserSmokeOptions, hideWindow: boolean) {
  return resolveBrowserConfig({
    transport: "cdp",
    manualLogin: true,
    manualLoginProfileDir: options.profileDir,
    cookieSync: false,
    debugPort: options.port,
    chromePath: options.chromePath,
    headless: false,
    hideWindow,
    useMockKeychain: options.useMockKeychain,
    keepBrowser: false,
  });
}

async function enablePage(client: ChromeClient): Promise<void> {
  await client.Page.enable();
  await client.Runtime.enable();
}

async function waitForDevToolsToStop(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const probe = await verifyDevToolsReachable({ port, attempts: 1, timeoutMs: 250 });
    if (!probe.ok) return;
    await delay(100);
  }
  throw new Error(`Chrome DevTools endpoint 127.0.0.1:${port} remained live after shutdown.`);
}

async function closeLaunchedChrome(
  chrome: LaunchedChrome,
  client: ChromeClient | null,
  profileDir: string,
  logger: BrowserLogger,
): Promise<void> {
  await client?.close().catch(() => undefined);
  try {
    await chrome.kill();
  } catch {
    // Continue to the endpoint shutdown check for an exact outcome.
  }
  await waitForDevToolsToStop(chrome.port);
  await cleanupStaleProfileState(profileDir, logger, { lockRemovalMode: "never" });
}

async function assertSmokePortAvailable(profileDir: string, port: number): Promise<void> {
  const running = await findRunningChromeForProfile(profileDir);
  if (running) {
    throw new Error(
      `Dedicated Oracle Chrome is already running for ${profileDir} (pid ${running.pid}${running.port ? `, port ${running.port}` : ""}). Close it before the two-cold-start smoke.`,
    );
  }
  const probe = await verifyDevToolsReachable({ port, attempts: 1, timeoutMs: 250 });
  if (probe.ok) {
    throw new Error(
      `Loopback port ${port} is already serving a DevTools endpoint. Choose another port with --port.`,
    );
  }
}

export async function runDedicatedBrowserSetup(options: DedicatedBrowserSetupOptions): Promise<{
  profileDir: string;
  pid?: number;
  debugging: false;
  promptSubmitted: false;
  closed: true;
  keychainMode: "mock" | "system";
}> {
  const logger = createLogger(options.verbose);
  await ensureDedicatedBrowserProfileDirectory(options.profileDir);
  const running = await findRunningChromeForProfile(options.profileDir);
  if (running) {
    throw new Error(
      `Dedicated Oracle Chrome is already running for ${options.profileDir} (pid ${running.pid}). Close it before starting setup.`,
    );
  }
  const dedicatedChromePath = await resolveDedicatedBrowserExecutable(options.chromePath);
  const chromePath = dedicatedChromePath ?? Launcher.getFirstInstallation();
  if (!chromePath) {
    throw new Error(
      "No dedicated Chrome executable was found. Run `oracle browser install` or pass a compatible executable with --chrome-path.",
    );
  }
  const args = buildDedicatedSetupArgs(options.profileDir, options.useMockKeychain);
  const child = spawn(chromePath, args, {
    detached: false,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  logger(`Started dedicated browser pid ${child.pid ?? "unknown"} for dedicated-profile sign-in`);
  options.onStarted?.({ profileDir: options.profileDir, pid: child.pid });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  if (exit.code !== 0) {
    throw new Error(
      `Dedicated sign-in Chrome exited unexpectedly (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`}).`,
    );
  }
  return {
    profileDir: options.profileDir,
    pid: child.pid,
    debugging: false,
    promptSubmitted: false,
    closed: true,
    keychainMode: options.useMockKeychain ? "mock" : "system",
  };
}

function buildDedicatedSetupArgs(profileDir: string, useMockKeychain = false): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // The setup window exists only to establish ChatGPT's web session. Keep a
    // Google OAuth sign-in from turning the dedicated profile into a synced
    // copy of the operator's normal browser or activating unrelated extensions.
    "--disable-extensions",
    "--disable-sync",
    ...(useMockKeychain && process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    "--new-window",
    CHATGPT_URL,
  ];
}

export function buildDedicatedSetupArgsForTest(
  profileDir: string,
  useMockKeychain = false,
): string[] {
  return buildDedicatedSetupArgs(profileDir, useMockKeychain);
}

export async function runDedicatedBrowserSmoke(
  options: DedicatedBrowserSmokeOptions,
): Promise<DedicatedBrowserSmokeResult> {
  const logger = createLogger(options.verbose);
  await ensureDedicatedBrowserProfileDirectory(options.profileDir);
  await assertManualLoginProfileReadyForRun({
    userDataDir: options.profileDir,
    keepBrowser: false,
  });
  await assertSmokePortAvailable(options.profileDir, options.port);
  const config = resolveDedicatedConfig(options, !options.visible);
  const cycles: DedicatedBrowserSmokeCycle[] = [];

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const startedAt = Date.now();
    let chrome: LaunchedChrome | null = null;
    let client: ChromeClient | null = null;
    try {
      chrome = await launchChrome(config, options.profileDir, logger);
      client = await connectToChrome(chrome.port, logger, "127.0.0.1");
      await enablePage(client);
      if (!options.visible) {
        await positionChromeWindowOffscreen(client, logger);
      }
      await navigateToChatGPT(client.Page, client.Runtime, CHATGPT_URL, logger);
      await ensureNotBlocked(client.Runtime, false, logger);
      await ensureLoggedIn(client.Runtime, logger);
      await ensurePromptReady(client.Runtime, config.inputTimeoutMs, logger);
      const href = await client.Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const pageUrl = typeof href.result?.value === "string" ? href.result.value : CHATGPT_URL;
      const pageHost = new URL(pageUrl).host;
      cycles.push({
        cycle,
        pid: chrome.pid,
        port: chrome.port,
        host: "127.0.0.1",
        pageHost,
        authenticated: true,
        promptReady: true,
        promptSubmitted: false,
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      if (chrome) {
        await closeLaunchedChrome(chrome, client, options.profileDir, logger);
      } else {
        await client?.close().catch(() => undefined);
      }
    }
  }

  return {
    ok: true,
    transport: "direct-cdp",
    profileDir: options.profileDir,
    keychainMode: options.useMockKeychain ? "mock" : "system",
    coldStarts: 2,
    recurringApprovalRequired: false,
    promptSubmitted: false,
    cycles,
  };
}

export function printDedicatedBrowserSetupResult(
  result: Awaited<ReturnType<typeof runDedicatedBrowserSetup>>,
  json = false,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Oracle sign-in browser completed (pid ${result.pid ?? "unknown"}; CDP disabled).`,
      `Profile: ${result.profileDir}`,
      `Keychain mode: ${result.keychainMode}`,
      "The whole sign-in browser is now closed. Run `oracle browser smoke` to validate two cold CDP attaches.",
      "This setup window has no CDP endpoint or prompt automation. No prompt was submitted.",
    ].join("\n") + "\n",
  );
}

export function printDedicatedBrowserSmokeResult(
  result: DedicatedBrowserSmokeResult,
  json = false,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Dedicated Chrome smoke passed: ${result.coldStarts}/2 cold starts attached over loopback CDP.`,
      "The same persistent profile was authenticated on both starts; no prompt was submitted and no recurring browser approval was requested.",
      `Profile: ${result.profileDir}`,
      `Keychain mode: ${result.keychainMode}`,
    ].join("\n") + "\n",
  );
}
