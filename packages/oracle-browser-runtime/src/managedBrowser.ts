import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { LaunchedManagedBrowser, ManagedBrowserLaunchInput } from "./types.js";
import { captureManagedBrowserProcessIdentity } from "./processIdentity.js";
import { closeRestoredBrowserPages, readRecoveryWindowName } from "./reconcile.js";

const LOOPBACK_HOST = "127.0.0.1";
const BACKGROUND_STARTING_URL = "--no-startup-window";

type LauncherHandle = Pick<LaunchedChrome, "port" | "kill"> & {
  process?: ChildProcess;
};

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
    const processIdentity = input.captureProcessIdentity
      ? await captureManagedBrowserProcessIdentity({
          browser,
          executablePath: input.executablePath,
          profileDir: input.profileDir,
          debugPort: launcher.port,
        })
      : undefined;
    if (processIdentity) await input.onProcessIdentity?.(processIdentity);
    const preserveWindowNames = new Set(input.preserveWindowNames ?? []);
    const singlePageLifetime = input.singlePageLifetime ?? false;
    const ownedPages = new Set<Page>();
    const preservedPages = new Set<Page>();
    const pendingMarkers = new Set<string>();
    let closed = false;
    let closeAttempt: Promise<void> | undefined;
    const ownPage = (page: Page) => {
      if (ownedPages.has(page)) return;
      ownedPages.add(page);
      page.once("close", () => {
        ownedPages.delete(page);
        preservedPages.delete(page);
      });
    };
    const preservePage = (page: Page): Promise<Page> =>
      preserveManagedPage(page, { ownedPages, preservedPages, singlePageLifetime, ownPage });
    const closeLateUnownedPage = (page: Page) => {
      void delay(50).then(async () => {
        if (
          closed ||
          closeAttempt ||
          page.isClosed() ||
          ownedPages.has(page) ||
          pendingMarkers.has(page.url())
        ) {
          return;
        }
        let recoveryWindowName: string;
        try {
          recoveryWindowName = await readRecoveryWindowName(context, page);
        } catch {
          // A late-restored page can still be an exact recovery target. Leave it
          // open when its marker cannot yet be inspected rather than risk losing
          // durable at-risk work.
          return;
        }
        if (preserveWindowNames.has(recoveryWindowName)) {
          await preservePage(page);
          return;
        }
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
      });
    };
    context.on("page", closeLateUnownedPage);
    const restoredPageCount = await closeRestoredBrowserPages(context, {
      preserveWindowNames: [...preserveWindowNames],
    });
    for (const page of context.pages()) {
      if (
        !page.isClosed() &&
        preserveWindowNames.has(await readRecoveryWindowName(context, page))
      ) {
        await preservePage(page);
      }
    }
    return {
      context,
      browserVersion: browser.version(),
      executablePath: input.executablePath,
      restoredPageCount,
      preservedPages: () => [...preservedPages].filter((page) => !page.isClosed()),
      ...(processIdentity ? { processIdentity } : {}),
      async openPage(url) {
        if (closed || closeAttempt) {
          throw new Error("Managed Chrome for Testing runtime is closing or closed");
        }
        const preserved = [...preservedPages].find((page) => !page.isClosed());
        if (singlePageLifetime && preserved) return preserved;
        const marker = `about:blank#oracle-v2-target-${randomUUID()}`;
        pendingMarkers.add(marker);
        const session = await browser!.newBrowserCDPSession();
        let targetId: string | undefined;
        try {
          const created = await session.send("Target.createTarget", {
            url: marker,
            background: false,
            focus: false,
          });
          targetId = created.targetId;
          const page = await waitForExactPage(context, marker, 15_000);
          ownPage(page);
          pendingMarkers.delete(marker);
          await page.goto(url, { waitUntil: "commit", timeout: 15_000 });
          await closeCurrentlyUnownedPages(
            context,
            ownedPages,
            pendingMarkers,
            preserveWindowNames,
            preservePage,
          );
          const recovered = [...preservedPages].find((candidate) => !candidate.isClosed());
          if (singlePageLifetime && recovered) {
            if (recovered !== page && !page.isClosed()) {
              await page.close({ runBeforeUnload: false }).catch(() => undefined);
            }
            return recovered;
          }
          return page;
        } catch (error) {
          if (targetId) {
            await session.send("Target.closeTarget", { targetId }).catch(() => undefined);
          }
          throw error;
        } finally {
          pendingMarkers.delete(marker);
          await session.detach().catch(() => undefined);
        }
      },
      async close() {
        if (closed) return;
        if (closeAttempt) return closeAttempt;
        const attempt = (async () => {
          await closeOwnedBrowser(browser!, launcher, endpoint);
          context.off("page", closeLateUnownedPage);
          closed = true;
        })();
        closeAttempt = attempt;
        try {
          await attempt;
        } finally {
          if (closeAttempt === attempt) closeAttempt = undefined;
        }
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    launcher.kill();
    throw error;
  }
}

async function waitForExactPage(
  context: BrowserContext,
  marker: string,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = context
      .pages()
      .find((candidate) => !candidate.isClosed() && candidate.url() === marker);
    if (page) return page;
    await delay(25);
  }
  throw new Error("Managed Chrome for Testing did not expose the exact created target");
}

async function closeCurrentlyUnownedPages(
  context: BrowserContext,
  ownedPages: ReadonlySet<Page>,
  pendingMarkers: ReadonlySet<string>,
  preserveWindowNames: ReadonlySet<string>,
  preservePage: (page: Page) => Promise<Page>,
): Promise<void> {
  const unowned = context
    .pages()
    .filter((page) => !page.isClosed() && !ownedPages.has(page) && !pendingMarkers.has(page.url()));
  for (const page of unowned) {
    let recoveryWindowName: string;
    try {
      recoveryWindowName = await readRecoveryWindowName(context, page);
    } catch (error) {
      if (page.isClosed()) {
        continue;
      }
      throw error;
    }
    if (preserveWindowNames.has(recoveryWindowName)) {
      await preservePage(page);
      continue;
    }
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
}

async function preserveManagedPage(
  page: Page,
  input: {
    ownedPages: Set<Page>;
    preservedPages: Set<Page>;
    singlePageLifetime: boolean;
    ownPage: (page: Page) => void;
  },
): Promise<Page> {
  const existing = [...input.preservedPages].find((candidate) => !candidate.isClosed());
  if (input.singlePageLifetime && existing && existing !== page) {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    return existing;
  }
  input.ownPage(page);
  if (input.singlePageLifetime) {
    for (const owned of input.ownedPages) {
      if (owned !== page) {
        await owned.close({ runBeforeUnload: false }).catch(() => undefined);
      }
    }
  }
  input.preservedPages.add(page);
  return page;
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
  return {
    port: launcher.port,
    kill: () => launcher.kill(),
    process: launcher.chromeProcess,
  };
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
  await waitForProcessExit(launcher.process, 5_000);
  launcher.kill();
  if (!closedGracefully && !(await waitForEndpoint(endpoint, false, 2_000))) {
    throw new Error("Managed Chrome for Testing did not close its loopback CDP endpoint");
  }
}

async function waitForProcessExit(
  child: ChildProcess | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
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

export const managedBrowserTestHooks = {
  preserveManagedPage,
};
