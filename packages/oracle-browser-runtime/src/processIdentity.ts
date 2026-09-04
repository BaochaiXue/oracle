import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright-core";
import type { AttemptProcessReceipt, ManagedBrowserProcessIdentity } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ObservedManagedBrowserProcess {
  pid: number;
  processStartTime: string;
  command: string;
  executableRealpath?: string;
}

export interface ProcessIdentityDependencies {
  observeProcess?: (
    pid: number,
    executablePath: string,
  ) => Promise<ObservedManagedBrowserProcess | undefined>;
  closeOverCdp?: (receipt: AttemptProcessReceipt) => Promise<void>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface ProcessInspectionDependencies {
  execProcess?: (
    file: string,
    args: string[],
    options: { maxBuffer: number },
  ) => Promise<{ stdout?: string | Buffer }>;
  processExists?: (pid: number) => Promise<boolean>;
}

export async function findManagedBrowserProcessesUsingProfile(
  profileDir: string,
): Promise<Array<{ pid: number; processStartTime: string }>> {
  if (process.platform === "win32") {
    throw new Error("Managed browser profile process inspection is unavailable on Windows");
  }
  const profileRealpath = await realpath(profileDir);
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=", "-o", "lstart=", "-o", "command="],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const lines = String(stdout ?? "")
    .split("\n")
    .filter((line) => line.trim());
  const observations = lines.map((line) => parseProcessObservation(line));
  if (observations.some((observation) => !observation)) {
    throw new Error("Managed browser profile process inspection returned an unparseable row");
  }
  return observations
    .filter((observation): observation is ObservedManagedBrowserProcess =>
      Boolean(
        observation && commandFlagValue(observation.command, "--user-data-dir") === profileRealpath,
      ),
    )
    .map(({ pid, processStartTime }) => ({ pid, processStartTime }));
}

export async function readBrowserPid(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send("SystemInfo.getProcessInfo");
    const browserProcess = result.processInfo.find((entry) => entry.type === "browser");
    if (!browserProcess || !Number.isSafeInteger(browserProcess.id) || browserProcess.id <= 0) {
      throw new Error("Managed Chrome for Testing did not report its browser process ID");
    }
    return browserProcess.id;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function captureManagedBrowserProcessIdentity(input: {
  browser: Browser;
  executablePath: string;
  profileDir: string;
  debugPort: number;
  observeProcess?: ProcessIdentityDependencies["observeProcess"];
}): Promise<ManagedBrowserProcessIdentity> {
  const executableRealpath = await realpath(input.executablePath);
  const profileRealpath = await realpath(input.profileDir);
  const pid = await readBrowserPid(input.browser);
  const observe = input.observeProcess ?? observeManagedBrowserProcess;
  const observed = await observe(pid, executableRealpath);
  if (
    !observed ||
    !managedBrowserCommandMatches(observed.command, {
      executableRealpath,
      profileRealpath,
      debugPort: input.debugPort,
    }) ||
    (observed.executableRealpath && observed.executableRealpath !== executableRealpath)
  ) {
    throw new Error("Managed Chrome for Testing process identity could not be proven exactly");
  }
  return {
    pid,
    processStartTime: observed.processStartTime,
    executableRealpath,
    profileRealpath,
    debugHost: "127.0.0.1",
    debugPort: input.debugPort,
  };
}

export async function observeManagedBrowserProcess(
  pid: number,
  executablePath: string,
  dependencies: ProcessInspectionDependencies = {},
): Promise<ObservedManagedBrowserProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Managed browser process inspection requires a positive integer PID");
  }
  if (process.platform === "win32" && !dependencies.execProcess) {
    throw new Error("Managed browser process inspection is unavailable on Windows");
  }
  const exists = dependencies.processExists ?? processExists;
  if (!(await exists(pid))) return undefined;
  try {
    const { stdout } = await (dependencies.execProcess ?? execFileAsync)(
      "ps",
      ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
      { maxBuffer: 1024 * 1024 },
    );
    const parsed = parseProcessObservation(String(stdout ?? ""));
    if (!parsed) {
      if (!(await exists(pid))) return undefined;
      throw new Error("Managed browser process inspection returned an unparseable row");
    }
    const executableRealpath =
      process.platform === "linux"
        ? await realpath(`/proc/${pid}/exe`).catch(() => undefined)
        : managedBrowserCommandUsesExecutable(parsed.command, executablePath)
          ? executablePath
          : undefined;
    return { ...parsed, ...(executableRealpath ? { executableRealpath } : {}) };
  } catch (error) {
    if (!(await exists(pid))) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Managed browser process inspection failed: ${detail}`, { cause: error });
  }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function managedBrowserProcessMatchesReceipt(
  observed: ObservedManagedBrowserProcess,
  receipt: AttemptProcessReceipt,
): boolean {
  return (
    observed.pid === receipt.pid &&
    observed.processStartTime === receipt.processStartTime &&
    (!observed.executableRealpath || observed.executableRealpath === receipt.executableRealpath) &&
    managedBrowserCommandMatches(observed.command, {
      executableRealpath: receipt.executableRealpath,
      profileRealpath: receipt.profileRealpath,
      debugPort: receipt.debugPort,
    })
  );
}

export async function closeManagedBrowserOverCdp(receipt: AttemptProcessReceipt): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(`http://${receipt.debugHost}:${receipt.debugPort}`, {
      timeout: 2_000,
    });
    const session = await browser.newBrowserCDPSession();
    try {
      await session.send("Browser.close");
    } finally {
      await session.detach().catch(() => undefined);
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function parseProcessObservation(stdout: string): ObservedManagedBrowserProcess | undefined {
  const match = stdout.trim().match(/^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/u);
  if (!match) return undefined;
  const pid = Number.parseInt(match[1] ?? "", 10);
  const processStartTime = match[2]?.replace(/\s+/gu, " ").trim();
  const command = match[3]?.trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processStartTime || !command) return undefined;
  return { pid, processStartTime, command };
}

function managedBrowserCommandMatches(
  command: string,
  expected: { executableRealpath: string; profileRealpath: string; debugPort: number },
): boolean {
  return (
    managedBrowserCommandUsesExecutable(command, expected.executableRealpath) &&
    commandFlagValue(command, "--user-data-dir") === expected.profileRealpath &&
    commandFlagValue(command, "--remote-debugging-port") === String(expected.debugPort)
  );
}

function managedBrowserCommandUsesExecutable(command: string, executablePath: string): boolean {
  return (
    command === executablePath ||
    command.startsWith(`${executablePath} `) ||
    command === `"${executablePath}"` ||
    command.startsWith(`"${executablePath}" `) ||
    command === `'${executablePath}'` ||
    command.startsWith(`'${executablePath}' `)
  );
}

function commandFlagValue(command: string, flag: string): string | undefined {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = command.match(new RegExp(`(?:^|\\s)${escaped}=(.*?)(?=\\s+--|$)`, "u"));
  return match?.[1]?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2").trim();
}

export const processIdentityTestHooks = {
  parseProcessObservation,
  managedBrowserCommandMatches,
  commandFlagValue,
};
