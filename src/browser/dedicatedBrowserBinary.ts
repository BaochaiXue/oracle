import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserPlatform, InstalledBrowser } from "@puppeteer/browsers";
import { BrowserAutomationError } from "../oracle/errors.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { readProcessCommand } from "./profileState.js";

const execFileAsync = promisify(execFile);
type PuppeteerBrowsersModule = typeof import("@puppeteer/browsers");
let puppeteerBrowsersModule: Promise<PuppeteerBrowsersModule> | undefined;

function loadPuppeteerBrowsers(): Promise<PuppeteerBrowsersModule> {
  puppeteerBrowsersModule ??= import("@puppeteer/browsers");
  return puppeteerBrowsersModule;
}

export const SHARED_MACOS_STABLE_CHROME_BUNDLE_ID = "com.google.Chrome";

export function defaultDedicatedBrowserCacheDir(): string {
  return path.join(getOracleHomeDir(), "browsers");
}

export interface DedicatedBrowserInstallReceipt {
  browser: "chrome-for-testing";
  channel: "stable";
  buildId: string;
  platform: string;
  cacheDir: string;
  executablePath: string;
}

export async function installDedicatedBrowser(
  cacheDir = defaultDedicatedBrowserCacheDir(),
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<DedicatedBrowserInstallReceipt> {
  const browserTools = await loadPuppeteerBrowsers();
  const platform = browserTools.detectBrowserPlatform();
  if (!platform) {
    throw new Error(`Chrome for Testing is not available for ${process.platform}/${process.arch}.`);
  }
  const buildId = await browserTools.resolveBuildId(
    browserTools.Browser.CHROME,
    platform,
    browserTools.BrowserTag.STABLE,
  );
  const existingInstall = (await browserTools.getInstalledBrowsers({ cacheDir })).find(
    (entry) =>
      entry.browser === browserTools.Browser.CHROME &&
      entry.platform === platform &&
      entry.buildId === buildId,
  );
  const existingExecutable = existingInstall
    ? await fs.stat(existingInstall.executablePath).catch(() => null)
    : null;
  let installed: InstalledBrowser;
  if (existingInstall && existingExecutable?.isFile()) {
    installed = existingInstall;
  } else {
    await downloadDedicatedBrowserArchive({
      browserTools,
      cacheDir,
      platform,
      buildId,
      onProgress,
    });
    installed = await browserTools.install({
      browser: browserTools.Browser.CHROME,
      buildId,
      buildIdAlias: browserTools.BrowserTag.STABLE,
      cacheDir,
      platform,
    });
  }
  await assertDedicatedMacBrowserIdentity(installed.executablePath);
  return {
    browser: "chrome-for-testing",
    channel: "stable",
    buildId,
    platform,
    cacheDir,
    executablePath: installed.executablePath,
  };
}

async function downloadDedicatedBrowserArchive({
  browserTools,
  cacheDir,
  platform,
  buildId,
  onProgress,
}: {
  browserTools: PuppeteerBrowsersModule;
  cacheDir: string;
  platform: BrowserPlatform;
  buildId: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}): Promise<string> {
  const downloadUrl = browserTools.getDownloadUrl(browserTools.Browser.CHROME, platform, buildId);
  const archiveName = path.basename(decodeURIComponent(downloadUrl.pathname));
  const browserRoot = path.join(cacheDir, browserTools.Browser.CHROME);
  const archivePath = path.join(browserRoot, `${buildId}-${archiveName}`);
  await fs.mkdir(browserRoot, { recursive: true, mode: 0o700 });

  return downloadArchiveWithResume({ downloadUrl, archivePath, onProgress });
}

async function downloadArchiveWithResume({
  downloadUrl,
  archivePath,
  onProgress,
  fetchImpl = fetch,
}: {
  downloadUrl: URL;
  archivePath: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const head = await fetchImpl(downloadUrl, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(
      `Chrome for Testing metadata request failed (${head.status} ${head.statusText}).`,
    );
  }
  const totalBytes = Number(head.headers.get("content-length"));
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error("Chrome for Testing download did not provide a valid Content-Length.");
  }

  let downloadedBytes = (await fs.stat(archivePath).catch(() => null))?.size ?? 0;
  if (downloadedBytes > totalBytes) {
    await fs.truncate(archivePath, 0);
    downloadedBytes = 0;
  }
  onProgress?.(downloadedBytes, totalBytes);
  if (downloadedBytes === totalBytes) return archivePath;

  let response = await fetchImpl(downloadUrl, {
    headers: downloadedBytes > 0 ? { Range: `bytes=${downloadedBytes}-` } : undefined,
  });
  if (downloadedBytes > 0 && response.status === 200) {
    await response.body?.cancel().catch(() => undefined);
    await fs.truncate(archivePath, 0);
    downloadedBytes = 0;
    response = await fetchImpl(downloadUrl);
  }
  const expectedStatus = downloadedBytes > 0 ? 206 : 200;
  if (response.status !== expectedStatus || !response.body) {
    throw new Error(
      `Chrome for Testing download could not ${downloadedBytes > 0 ? "resume" : "start"} (HTTP ${response.status} ${response.statusText}).`,
    );
  }

  const file = await fs.open(archivePath, downloadedBytes > 0 ? "a" : "w", 0o600);
  try {
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await file.write(chunk.value);
      downloadedBytes += chunk.value.byteLength;
      onProgress?.(downloadedBytes, totalBytes);
    }
  } finally {
    await file.close();
  }
  if (downloadedBytes !== totalBytes) {
    throw new Error(
      `Chrome for Testing download stopped at ${downloadedBytes}/${totalBytes} bytes. Rerun \`oracle browser install\` to resume the same archive.`,
    );
  }
  return archivePath;
}

export async function downloadArchiveWithResumeForTest(options: {
  downloadUrl: URL;
  archivePath: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  return downloadArchiveWithResume(options);
}

export async function findInstalledDedicatedBrowser(
  cacheDir = defaultDedicatedBrowserCacheDir(),
): Promise<string | null> {
  const browserTools = await loadPuppeteerBrowsers();
  const versionComparator = browserTools.getVersionComparator(browserTools.Browser.CHROME);
  const installed = (await browserTools.getInstalledBrowsers({ cacheDir }))
    .filter((entry) => entry.browser === browserTools.Browser.CHROME)
    .sort((left, right) => versionComparator(right.buildId, left.buildId));
  for (const entry of installed) {
    const stat = await fs.stat(entry.executablePath).catch(() => null);
    if (stat?.isFile()) return entry.executablePath;
  }
  return null;
}

export async function resolveDedicatedBrowserExecutable(
  configuredPath?: string | null,
): Promise<string | null> {
  const explicit = configuredPath?.trim();
  const executablePath = explicit || (await findInstalledDedicatedBrowser());
  if (executablePath) {
    await assertDedicatedMacBrowserIdentity(executablePath);
    return executablePath;
  }
  if (process.platform === "darwin") {
    throw new BrowserAutomationError(
      "Oracle's dedicated profile needs a browser with a separate macOS app identity. Install the official Chrome for Testing build with `oracle browser install`; Oracle will not launch your everyday Google Chrome app because it can intercept normal browser links while running.",
      {
        stage: "browser-app-identity",
        code: "dedicated-browser-missing",
        installCommand: "oracle browser install",
      },
    );
  }
  return null;
}

export async function assertDedicatedMacBrowserIdentity(executablePath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const appBundlePath = findContainingAppBundle(executablePath);
  if (!appBundlePath) {
    throw browserIdentityError(
      executablePath,
      null,
      "the executable is not inside an inspectable macOS app bundle",
    );
  }
  const infoPlistPath = path.join(appBundlePath, "Contents", "Info.plist");
  let bundleId: string;
  try {
    const result = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
      { encoding: "utf8" },
    );
    bundleId = result.stdout.trim();
  } catch (error) {
    throw browserIdentityError(executablePath, null, "CFBundleIdentifier could not be read", error);
  }
  if (!bundleId) {
    throw browserIdentityError(executablePath, null, "CFBundleIdentifier is empty");
  }
  if (isSharedMacBrowserBundleId(bundleId)) {
    throw browserIdentityError(
      executablePath,
      bundleId,
      "it shares the application identity of everyday Google Chrome and can intercept system links",
    );
  }
}

export function isSharedMacBrowserBundleId(bundleId: string): boolean {
  return bundleId === SHARED_MACOS_STABLE_CHROME_BUNDLE_ID;
}

export function findContainingAppBundle(executablePath: string): string | null {
  let current = path.resolve(executablePath);
  while (true) {
    if (current.toLowerCase().endsWith(".app")) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function browserCommandUsesExecutable(
  command: string | null,
  executablePath: string,
): boolean {
  if (!command) return false;
  const expected = path.resolve(executablePath);
  return command === expected || command.startsWith(`${expected} `);
}

export async function assertDedicatedBrowserProcessIdentity(
  pid: number | undefined,
  executablePath: string,
): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!pid) {
    throw runningBrowserIdentityError(undefined, executablePath);
  }
  const command = await readProcessCommand(pid);
  if (browserCommandUsesExecutable(command, executablePath)) return;
  throw runningBrowserIdentityError(pid, executablePath);
}

function runningBrowserIdentityError(
  pid: number | undefined,
  executablePath: string,
): BrowserAutomationError {
  return new BrowserAutomationError(
    "Refusing to reuse the Chrome process recorded for Oracle's dedicated profile because it was not launched from the configured dedicated browser executable. Close that browser and retry; Oracle will not attach to everyday Google Chrome.",
    {
      stage: "browser-app-identity",
      code: "running-browser-app-identity-mismatch",
      pid: pid ?? null,
      executablePath,
      retryGuidance: "close-mismatched-browser-and-retry",
    },
  );
}

function browserIdentityError(
  executablePath: string,
  bundleId: string | null,
  reason: string,
  cause?: unknown,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Refusing dedicated Oracle Chrome executable ${executablePath}: ${reason}. Run \`oracle browser install\` to install an app-identity-isolated Chrome for Testing build.`,
    {
      stage: "browser-app-identity",
      code: "shared-browser-app-identity",
      executablePath,
      bundleId,
      installCommand: "oracle browser install",
    },
    cause,
  );
}
