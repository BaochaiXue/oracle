import { chmod, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";

export function resolveManualLoginWaitMs(timeoutMs: number | undefined, keepBrowser: boolean) {
  const configured = Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  if (keepBrowser) {
    return configured;
  }
  return Math.min(configured, 30_000);
}

export async function ensureDedicatedBrowserProfileDirectory(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(profileDir, 0o700);
  }
}

export async function assertManualLoginProfileReadyForRun({
  userDataDir,
  keepBrowser,
}: {
  userDataDir: string;
  keepBrowser: boolean;
}): Promise<void> {
  if (keepBrowser) {
    return;
  }
  if (await isManualLoginProfileInitialized(userDataDir)) {
    return;
  }
  const setupCommand = formatManualLoginSetupCommand(userDataDir);
  throw new BrowserAutomationError(
    "Oracle's dedicated ChatGPT Chrome profile is not initialized. " +
      `Browser mode is using Oracle's private Chrome for Testing profile at ${userDataDir}, separate from your normal Chrome app and profile. ` +
      `Run \`oracle browser install\`, then first-time setup, sign in there, close the whole browser, and retry: ${setupCommand}. ` +
      "If you want to reuse an already signed-in Chrome instead, use --browser-attach-running.",
    {
      stage: "browser-login-setup",
      details: {
        profileDir: userDataDir,
        setupCommand,
        sessionStatus: "needs_login",
      },
      reuseProfileHint: setupCommand,
    },
  );
}

export async function isManualLoginProfileInitialized(profileDir: string): Promise<boolean> {
  const entries = await readdir(profileDir, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => {
    if (!entry.name) return false;
    if (entry.name === "Default" || entry.name === "Local State") return true;
    if (entry.name.startsWith("Profile ")) return true;
    return false;
  });
}

export function formatManualLoginSetupCommand(profileDir: string): string {
  return `oracle browser setup --profile-dir ${JSON.stringify(profileDir)}`;
}

export function defaultManualLoginProfileDir() {
  return path.join(os.homedir(), ".oracle", "browser-profile");
}
