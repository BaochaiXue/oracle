import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectOracleBrowserRuntime } from "./discovery.js";
import { launchManagedChromeForTesting } from "./managedBrowser.js";
import { ORACLE_BROWSER_RUNTIME_ID } from "./types.js";
import type {
  LaunchManagedBrowser,
  OracleBrowserRuntime,
  RuntimeInspectionOptions,
  RuntimeLaunchReceipt,
} from "./types.js";

const PROFILE_DIRECTORY = "browser-profile";
const PROFILE_MARKER = "runtime-profile.json";
const LAUNCH_RECEIPT = "browser-runtime-launch.json";

export async function launchOracleBrowserRuntime(options: {
  runtimeRoot: string;
  headless?: boolean;
  inspection?: RuntimeInspectionOptions;
  launchManagedBrowser?: LaunchManagedBrowser;
}): Promise<OracleBrowserRuntime> {
  const inspection = inspectOracleBrowserRuntime(options.inspection);
  if (inspection.availability !== "available" || !inspection.executablePath) {
    throw new Error(`Managed Chrome for Testing runtime is unavailable: ${inspection.reason}`);
  }

  const runtimeRoot = path.resolve(options.runtimeRoot);
  const profileDir = path.join(runtimeRoot, PROFILE_DIRECTORY);
  ensurePrivateDirectory(runtimeRoot);
  ensurePrivateDirectory(profileDir);
  bindProfile(profileDir);
  const previous = readRuntimeLaunchReceipt(runtimeRoot);
  const restartOrdinal =
    previous?.schemaVersion === "oracle.browser-runtime-launch.v2" &&
    previous.runtimeId === ORACLE_BROWSER_RUNTIME_ID
      ? previous.restartOrdinal + 1
      : 1;

  const launch = options.launchManagedBrowser ?? launchManagedChromeForTesting;
  const launched = await launch({
    executablePath: inspection.executablePath,
    profileDir,
    headless: options.headless ?? false,
  });
  const receipt: RuntimeLaunchReceipt = {
    schemaVersion: "oracle.browser-runtime-launch.v2",
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    browserRuntimeId: `${ORACLE_BROWSER_RUNTIME_ID}:${launched.browserVersion}`,
    processOwner: "oracle-worker",
    transport: "direct-cdp",
    profileDir,
    executablePath: launched.executablePath,
    browserVersion: launched.browserVersion,
    restoredPageCount: launched.restoredPageCount,
    restartOrdinal,
    automaticFallback: false,
    launchedAt: new Date().toISOString(),
  };
  try {
    writePrivateJson(path.join(runtimeRoot, LAUNCH_RECEIPT), receipt);
  } catch (error) {
    await launched.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    context: launched.context,
    receipt,
    openPage: (url) => launched.openPage(url),
    async close() {
      if (closed) return;
      closed = true;
      await launched.close();
      receipt.closedAt = new Date().toISOString();
      writePrivateJson(path.join(runtimeRoot, LAUNCH_RECEIPT), receipt);
    },
  };
}

export function readRuntimeLaunchReceipt(runtimeRoot: string): RuntimeLaunchReceipt | undefined {
  return readJson<RuntimeLaunchReceipt>(path.join(path.resolve(runtimeRoot), LAUNCH_RECEIPT));
}

export function sanitizeRuntimeObservationUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "unavailable";
  }
}

function bindProfile(profileDir: string): void {
  const markerPath = path.join(profileDir, PROFILE_MARKER);
  const existing = readJson<{ schemaVersion?: string; runtimeId?: string }>(markerPath);
  if (existing) {
    if (existing.runtimeId !== ORACLE_BROWSER_RUNTIME_ID) {
      throw new Error(
        `Oracle v2 browser profile ${profileDir} is bound to ${String(existing.runtimeId)}; refusing ${ORACLE_BROWSER_RUNTIME_ID}`,
      );
    }
    return;
  }
  writePrivateJson(markerPath, {
    schemaVersion: "oracle.browser-runtime-profile.v2",
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    createdAt: new Date().toISOString(),
  });
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function writePrivateJson(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}
