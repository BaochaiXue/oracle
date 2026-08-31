import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import { chromium, type Browser } from "playwright-core";
import type { LaunchedManagedBrowser, ManagedBrowserLaunchInput } from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const BACKGROUND_STARTING_URL = "--no-startup-window";

type LauncherHandle = Pick<LaunchedChrome, "port" | "kill">;

export async function launchManagedChromeForTesting(
  input: ManagedBrowserLaunchInput,
): Promise<LaunchedManagedBrowser> {
  const launcher = await launchOwnedBrowser(input);
  const endpoint = `http://${LOOPBACK_HOST}:${launcher.port}`;
  let browser: Browser | undefined;
  try {
    browser = await connectOverCdp(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Managed Chrome for Testing did not expose its persistent context");
    }
    let closed = false;
    return {
      context,
      browserVersion: browser.version(),
      executablePath: input.executablePath,
      async openPage(url) {
        const pagePromise = context.waitForEvent("page", { timeout: 15_000 });
        const session = await browser!.newBrowserCDPSession();
        try {
          await session.send("Target.createTarget", {
            url,
            background: false,
            focus: false,
          });
          return await pagePromise;
        } finally {
          await session.detach().catch(() => undefined);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeOwnedBrowser(browser!, launcher, endpoint);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    launcher.kill();
    throw error;
  }
}

async function launchOwnedBrowser(input: ManagedBrowserLaunchInput): Promise<LauncherHandle> {
  const chromeFlags = buildManagedChromeFlags(input.headless);
  const options = {
    chromePath: input.executablePath,
    chromeFlags,
    userDataDir: input.profileDir,
    startingUrl: BACKGROUND_STARTING_URL,
    handleSIGINT: false,
    port: 0,
    portStrictMode: true,
    ignoreDefaultFlags: true,
  } as const;

  if (process.platform !== "darwin" || input.headless) {
    return await launch(options);
  }

  const appBundle = resolveMacAppBundle(input.executablePath);
  if (!appBundle) {
    throw new Error(
      `Managed Chrome for Testing executable is not inside a macOS app bundle: ${input.executablePath}`,
    );
  }
  const backgroundSpawn = ((
    _executable: string,
    args: readonly string[],
    spawnOptions: SpawnOptions,
  ): ChildProcess =>
    spawn(
      "/usr/bin/open",
      ["-g", "-W", "-n", "-a", appBundle, "--args", ...args],
      spawnOptions,
    )) as typeof spawn;
  const launcher = new Launcher(options, { spawn: backgroundSpawn });
  await launcher.launch();
  if (!launcher.port) {
    launcher.kill();
    throw new Error("Managed Chrome for Testing did not expose a loopback CDP port");
  }
  return { port: launcher.port, kill: () => launcher.kill() };
}

function buildManagedChromeFlags(headless: boolean): string[] {
  return [
    "--disable-backgrounding-occluded-windows",
    "--disable-component-extensions-with-background-pages",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--window-size=1280,720",
    "--lang=en-US",
    "--accept-lang=en-US,en",
    `--remote-debugging-address=${LOOPBACK_HOST}`,
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(headless ? ["--headless=new"] : []),
  ];
}

async function connectOverCdp(endpoint: string): Promise<Browser> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not attach Playwright to managed Chrome for Testing: ${message}`);
}

async function closeOwnedBrowser(
  browser: Browser,
  launcher: LauncherHandle,
  endpoint: string,
): Promise<void> {
  try {
    const session = await browser.newBrowserCDPSession();
    try {
      await session.send("Browser.close");
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    await browser.close().catch(() => undefined);
  }

  const closedGracefully = await waitForEndpoint(endpoint, false, 5_000);
  launcher.kill();
  if (!closedGracefully && !(await waitForEndpoint(endpoint, false, 2_000))) {
    throw new Error("Managed Chrome for Testing did not close its loopback CDP endpoint");
  }
}

async function waitForEndpoint(
  endpoint: string,
  expectedReachable: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await endpointReachable(endpoint)) === expectedReachable) return true;
    await delay(100);
  }
  return (await endpointReachable(endpoint)) === expectedReachable;
}

async function endpointReachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function resolveMacAppBundle(executablePath: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const markerIndex = executablePath.indexOf(marker);
  return markerIndex < 0 ? undefined : executablePath.slice(0, markerIndex + ".app".length);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
