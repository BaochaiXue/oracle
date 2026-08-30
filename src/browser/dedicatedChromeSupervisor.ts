import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  browserCommandUsesExecutable,
  listInstalledDedicatedBrowsers,
  resolveDedicatedBrowserExecutable,
} from "./dedicatedBrowserBinary.js";
import { launchChrome } from "./chromeLifecycle.js";
import {
  acquireProfileRunLock,
  findRunningChromeForProfile,
  getDevToolsActivePortPaths,
  isProcessAlive,
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
  type ProfileRunLock,
} from "./profileState.js";
import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import { delay } from "./utils.js";
import { readBrowserTargetRegistry } from "./tabLeaseRegistry.js";

const execFileAsync = promisify(execFile);
const RUNTIME_RECEIPT_FILENAME = "oracle-browser-runtime.json";
const CHROME_PID_FILENAME = "chrome.pid";
const STALE_LOCK_FILENAMES = [
  "lockfile",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export const CDP_CLOSE_WAIT_MS = 2_500;
export const SIGTERM_WAIT_MS = 2_500;
export const SIGKILL_CONFIRM_WAIT_MS = 1_000;

export type DedicatedBrowserOwnership =
  | "managed-current"
  | "managed-compatible"
  | "foreign-or-ambiguous";

export type DedicatedChromeState =
  | "absent"
  | "stale-metadata"
  | "healthy-current"
  | "healthy-managed-compatible"
  | "unreachable-managed"
  | "orphan-managed"
  | "protected-managed"
  | "ambiguous";

export type DedicatedChromeAction =
  | "launch-current"
  | "clear-stale-metadata-and-launch"
  | "reuse-current"
  | "reuse-compatible-and-defer-rollover"
  | "terminate-managed-and-launch-current"
  | "terminate-managed"
  | "clear-stale-metadata"
  | "preserve-protected"
  | "no-op"
  | "block-human-action";

export type DedicatedChromeActionMode = "acquire" | "heal" | "drain";

export interface ObservedProcess {
  pid: number;
  ppid?: number;
  command: string;
  executablePath?: string;
  executableRealpath?: string;
  processStartTime?: string;
}

export interface DedicatedChromeProcessFamilyMember {
  pid: number;
  ppid?: number;
  processStartTime: string;
  command: string;
  depth: number;
}

export interface DedicatedBrowserRuntimeReceipt {
  version: 1;
  pid: number;
  processStartTime: string;
  profileRealpath: string;
  executableRealpath: string;
  buildId?: string;
  platform: string;
  debugHost: "127.0.0.1";
  debugPort: number;
  launchedAt: string;
  lastVerifiedAt: string;
  rolloverPending?: boolean;
  controllerPid?: number;
  holdReason?: string;
  holdExpiresAt?: string;
}

export interface DedicatedChromeInspection {
  state: DedicatedChromeState;
  ownership: DedicatedBrowserOwnership | null;
  profileDir: string;
  profileRealpath: string;
  configuredExecutablePath: string | null;
  configuredExecutableRealpath: string | null;
  installedExecutableRealpaths: string[];
  installedBuildIds: Record<string, string>;
  recordedPid: number | null;
  recordedPort: number | null;
  observed: ObservedProcess | null;
  debugPort: number | null;
  endpointReachable: boolean;
  receipt: DedicatedBrowserRuntimeReceipt | null;
  metadataDrift: boolean;
  reason: string;
}

export interface DedicatedChromePlan {
  action: DedicatedChromeAction;
  reason: string;
}

export interface DedicatedChromeBootstrapOutcome {
  action: DedicatedChromeAction;
  repairAttempted: boolean;
  repairOutcome: string;
  rolloverPending: boolean;
}

export interface DedicatedChromeAcquireResult {
  chrome: LaunchedChrome & { host?: string };
  reusedChrome: LaunchedChrome | null;
  bootstrap: DedicatedChromeBootstrapOutcome;
}

export interface DedicatedChromeTerminationReceipt {
  status: "complete" | "blocked" | "failed";
  pid: number;
  debugPort: number;
  method?: "cdp" | "sigterm" | "sigkill";
  startedAt: string;
  completedAt: string;
  ownershipRevalidated: boolean;
  processExited: boolean;
  processFamilyPids: number[];
  processFamilyExited: boolean;
  endpointClosed: boolean;
  metadataCleared: boolean;
  error?: string;
}

export interface DedicatedChromeMaintenanceReceipt {
  mode: "heal" | "drain";
  planOnly: boolean;
  action: DedicatedChromeAction;
  stateBefore: DedicatedChromeState;
  stateAfter?: DedicatedChromeState;
  changed: boolean;
  protectedState: boolean;
  reason: string;
  termination?: DedicatedChromeTerminationReceipt;
}

interface InspectDeps {
  resolveExecutable?: typeof resolveDedicatedBrowserExecutable;
  listInstalled?: typeof listInstalledDedicatedBrowsers;
  readReceipt?: typeof readDedicatedBrowserRuntimeReceipt;
  readPid?: typeof readChromePid;
  readPort?: typeof readDevToolsPort;
  findProfileProcess?: typeof findRunningChromeForProfile;
  observeProcess?: typeof observeProcess;
  probe?: typeof verifyDevToolsReachable;
}

interface AcquireDeps extends InspectDeps {
  launch?: typeof launchChrome;
  writeReceipt?: typeof writeDedicatedBrowserRuntimeReceipt;
  acquireLock?: typeof acquireProfileRunLock;
  clearMetadata?: typeof clearDedicatedChromeMetadata;
  terminate?: typeof terminateVerifiedDedicatedChrome;
  readRegistry?: typeof readBrowserTargetRegistry;
  processAlive?: typeof isProcessAlive;
  wait?: (ms: number) => Promise<void>;
}

interface TerminateDeps extends InspectDeps {
  closeOverCdp?: typeof closeDedicatedChromeOverCdp;
  listProcesses?: typeof listObservedProcesses;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  clearMetadata?: typeof clearDedicatedChromeMetadata;
}

function runtimeReceiptPath(profileDir: string): string {
  return path.join(profileDir, RUNTIME_RECEIPT_FILENAME);
}

async function canonicalizePath(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => normalizeIdentityPath(candidate));
}

function isWindowsIdentityPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\");
}

function normalizeIdentityPath(candidate: string): string {
  const trimmed = candidate.trim();
  if (path.posix.isAbsolute(trimmed) && !isWindowsIdentityPath(trimmed)) {
    return path.posix.normalize(trimmed);
  }
  if (path.win32.isAbsolute(trimmed)) return path.win32.normalize(trimmed);
  return path.resolve(trimmed);
}

function identityPathKey(candidate: string): string {
  const normalized = normalizeIdentityPath(candidate);
  return isWindowsIdentityPath(candidate)
    ? normalized.replaceAll("/", "\\").toLowerCase()
    : normalized;
}

function sameIdentityPath(left: string, right: string): boolean {
  return identityPathKey(left) === identityPathKey(right);
}

function identityPathVariants(candidate: string): string[] {
  const raw = candidate.trim();
  const normalized = normalizeIdentityPath(raw);
  const variants = new Set([raw, normalized]);
  if (isWindowsIdentityPath(raw)) variants.add(normalized.replaceAll("\\", "/"));
  return [...variants];
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseRuntimeReceipt(raw: string): DedicatedBrowserRuntimeReceipt | null {
  try {
    const value = JSON.parse(raw) as Partial<DedicatedBrowserRuntimeReceipt>;
    if (
      value.version !== 1 ||
      !validPositiveInteger(value.pid) ||
      typeof value.processStartTime !== "string" ||
      !value.processStartTime ||
      typeof value.profileRealpath !== "string" ||
      !value.profileRealpath ||
      typeof value.executableRealpath !== "string" ||
      !value.executableRealpath ||
      typeof value.platform !== "string" ||
      value.debugHost !== "127.0.0.1" ||
      !validPositiveInteger(value.debugPort) ||
      typeof value.launchedAt !== "string" ||
      typeof value.lastVerifiedAt !== "string"
    ) {
      return null;
    }
    return value as DedicatedBrowserRuntimeReceipt;
  } catch {
    return null;
  }
}

export async function readDedicatedBrowserRuntimeReceipt(
  profileDir: string,
): Promise<DedicatedBrowserRuntimeReceipt | null> {
  const raw = await readFile(runtimeReceiptPath(profileDir), "utf8").catch(() => null);
  return raw ? parseRuntimeReceipt(raw) : null;
}

export async function writeDedicatedBrowserRuntimeReceipt(
  profileDir: string,
  receipt: DedicatedBrowserRuntimeReceipt,
): Promise<void> {
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = runtimeReceiptPath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, destination);
    if (process.platform !== "win32") {
      await chmod(destination, 0o600);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function processCommandUsesProfile(command: string, profileRealpath: string): boolean {
  const windowsPath = isWindowsIdentityPath(profileRealpath);
  const haystack = windowsPath ? command.toLowerCase() : command;
  return identityPathVariants(profileRealpath).some((candidate) => {
    const value = windowsPath ? candidate.toLowerCase() : candidate;
    const forms = [
      `--user-data-dir=${value}`,
      `--user-data-dir="${value}"`,
      `--user-data-dir='${value}'`,
      `--user-data-dir ${value}`,
      `--user-data-dir "${value}"`,
      `--user-data-dir '${value}'`,
    ];
    return forms.some((form) => {
      let offset = haystack.indexOf(form);
      while (offset >= 0) {
        const prefix = haystack.slice(0, offset);
        const suffix = haystack.slice(offset + form.length);
        const startsAtBoundary = offset === 0 || /\s$/u.test(prefix);
        const endsAtBoundary = suffix.length === 0 || /^\s+--/u.test(suffix);
        if (startsAtBoundary && endsAtBoundary) return true;
        offset = haystack.indexOf(form, offset + 1);
      }
      return false;
    });
  });
}

function processCommandUsesAnyProfile(command: string, profilePaths: string[]): boolean {
  const uniquePaths = new Map(
    profilePaths.map((candidate) => [identityPathKey(candidate), candidate]),
  );
  return [...uniquePaths.values()].some((candidate) =>
    processCommandUsesProfile(command, candidate),
  );
}

function processCommandUsesDebugPort(command: string, port: number): boolean {
  return commandFlagValues(command, "--remote-debugging-port").includes(String(port));
}

function commandFlagValues(command: string, flag: string): string[] {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matcher = new RegExp(
    `(?:^|\\s)${escapedFlag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))(?=\\s|$)`,
    "gu",
  );
  const values: string[] = [];
  for (const match of command.matchAll(matcher)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function commandUsesExecutable(command: string, executablePath: string): boolean {
  return (
    browserCommandUsesExecutable(command, executablePath) ||
    command === `"${executablePath}"` ||
    command.startsWith(`"${executablePath}" `) ||
    command === `'${executablePath}'` ||
    command.startsWith(`'${executablePath}' `)
  );
}

function receiptConflicts(input: {
  observed: ObservedProcess;
  receipt: DedicatedBrowserRuntimeReceipt;
  profileRealpath: string;
  debugPort: number;
}): boolean {
  const { observed, receipt, profileRealpath, debugPort } = input;
  return (
    receipt.pid !== observed.pid ||
    !observed.processStartTime ||
    receipt.processStartTime !== observed.processStartTime ||
    !sameIdentityPath(receipt.profileRealpath, profileRealpath) ||
    receipt.debugHost !== "127.0.0.1" ||
    receipt.debugPort !== debugPort ||
    !commandUsesExecutable(observed.command, receipt.executableRealpath)
  );
}

export function classifyDedicatedChromeOwnership(input: {
  observed: ObservedProcess;
  profileRealpath: string;
  debugPort: number;
  configuredExecutableRealpath: string | null;
  installedExecutableRealpaths: string[];
  receipt: DedicatedBrowserRuntimeReceipt | null;
  profilePathAliases?: string[];
}): DedicatedBrowserOwnership {
  const { observed, profileRealpath, debugPort, receipt } = input;
  if (
    !processCommandUsesAnyProfile(observed.command, [
      profileRealpath,
      ...(input.profilePathAliases ?? []),
    ]) ||
    !processCommandUsesDebugPort(observed.command, debugPort)
  ) {
    return "foreign-or-ambiguous";
  }
  if (receipt && receiptConflicts({ observed, receipt, profileRealpath, debugPort })) {
    return "foreign-or-ambiguous";
  }

  const observedExecutable = observed.executableRealpath ?? observed.executablePath;
  const current = input.configuredExecutableRealpath;
  if (
    current &&
    ((observedExecutable && sameIdentityPath(observedExecutable, current)) ||
      commandUsesExecutable(observed.command, current))
  ) {
    return "managed-current";
  }

  const installedMatch = input.installedExecutableRealpaths.some(
    (candidate) =>
      (observedExecutable && sameIdentityPath(observedExecutable, candidate)) ||
      commandUsesExecutable(observed.command, candidate),
  );
  if (installedMatch) {
    return "managed-compatible";
  }
  if (receipt && commandUsesExecutable(observed.command, receipt.executableRealpath)) {
    return "managed-compatible";
  }
  return "foreign-or-ambiguous";
}

function parsePsObservation(stdout: string): ObservedProcess | null {
  const match = stdout
    .trim()
    .match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/u);
  if (!match) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  const ppid = Number.parseInt(match[2] ?? "", 10);
  const processStartTime = match[3]?.replace(/\s+/gu, " ").trim();
  const command = match[4]?.trim();
  if (!validPositiveInteger(pid) || !command) return null;
  return {
    pid,
    ppid: validPositiveInteger(ppid) ? ppid : undefined,
    command,
    processStartTime: processStartTime || undefined,
  };
}

function inferKnownExecutable(command: string, knownExecutablePaths: string[]): string | undefined {
  return [...knownExecutablePaths]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => commandUsesExecutable(command, candidate));
}

export async function observeProcess(
  pid: number,
  knownExecutablePaths: string[] = [],
): Promise<ObservedProcess | null> {
  if (!validPositiveInteger(pid)) return null;
  if (process.platform === "win32") {
    const observations = await queryWindowsProcesses(pid);
    const observation = observations[0];
    if (!observation) return null;
    const executablePath =
      observation.executablePath ?? inferKnownExecutable(observation.command, knownExecutablePaths);
    return {
      ...observation,
      executablePath,
      executableRealpath: executablePath
        ? await realpath(executablePath).catch(() => normalizeIdentityPath(executablePath))
        : undefined,
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      [
        "-p",
        String(Math.trunc(pid)),
        "-o",
        "pid=",
        "-o",
        "ppid=",
        "-o",
        "lstart=",
        "-o",
        "command=",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const observation = parsePsObservation(String(stdout ?? ""));
    if (!observation) return null;
    let executablePath = inferKnownExecutable(observation.command, knownExecutablePaths);
    if (process.platform === "linux") {
      executablePath = await realpath(`/proc/${pid}/exe`).catch(() => executablePath);
    }
    return {
      ...observation,
      executablePath,
      executableRealpath: executablePath
        ? await realpath(executablePath).catch(() => undefined)
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function listObservedProcesses(): Promise<ObservedProcess[]> {
  if (process.platform === "win32") return queryWindowsProcesses();
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "command="],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return String(stdout ?? "")
      .split(/\r?\n/gu)
      .map((line) => parsePsObservation(line))
      .filter((entry): entry is ObservedProcess => Boolean(entry));
  } catch {
    return [];
  }
}

interface WindowsProcessRecord {
  pid?: unknown;
  ppid?: unknown;
  command?: unknown;
  executablePath?: unknown;
  processStartTime?: unknown;
}

function parseWindowsProcessRecord(value: WindowsProcessRecord): ObservedProcess | null {
  const pid = Number(value.pid);
  const ppid = Number(value.ppid);
  const executablePath =
    typeof value.executablePath === "string" && value.executablePath.trim()
      ? value.executablePath.trim()
      : undefined;
  const command =
    typeof value.command === "string" && value.command.trim()
      ? value.command.trim()
      : executablePath;
  const processStartTime =
    typeof value.processStartTime === "string" && value.processStartTime.trim()
      ? value.processStartTime.trim()
      : undefined;
  if (!validPositiveInteger(pid) || !command) return null;
  return {
    pid,
    ppid: validPositiveInteger(ppid) ? ppid : undefined,
    command,
    executablePath,
    processStartTime,
  };
}

async function queryWindowsProcesses(pid?: number): Promise<ObservedProcess[]> {
  const filter = pid ? ` -Filter "ProcessId = ${Math.trunc(pid)}"` : "";
  const script =
    `$items = Get-CimInstance Win32_Process${filter}\n` +
    "@($items | ForEach-Object { [pscustomobject]@{ " +
    "pid = [int]$_.ProcessId; " +
    "ppid = [int]$_.ParentProcessId; " +
    "command = [string]$_.CommandLine; " +
    "executablePath = [string]$_.ExecutablePath; " +
    "processStartTime = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) " +
    "} }) | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const raw = String(stdout ?? "")
      .replace(/^\uFEFF/u, "")
      .trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WindowsProcessRecord | WindowsProcessRecord[];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((entry) => parseWindowsProcessRecord(entry))
      .filter((entry): entry is ObservedProcess => Boolean(entry));
  } catch {
    return [];
  }
}

function metadataExists(input: {
  recordedPid: number | null;
  recordedPort: number | null;
  receipt: DedicatedBrowserRuntimeReceipt | null;
  staleLockPresent: boolean;
}): boolean {
  return Boolean(
    input.recordedPid || input.recordedPort || input.receipt || input.staleLockPresent,
  );
}

export async function inspectDedicatedChromeState(
  input: {
    profileDir: string;
    chromePath?: string | null;
  },
  deps: InspectDeps = {},
): Promise<DedicatedChromeInspection> {
  const profileDir = normalizeIdentityPath(input.profileDir);
  const profileRealpath = await canonicalizePath(profileDir);
  const resolveExecutable = deps.resolveExecutable ?? resolveDedicatedBrowserExecutable;
  const configuredExecutablePath = await resolveExecutable(input.chromePath);
  const configuredExecutableRealpath = configuredExecutablePath
    ? await canonicalizePath(configuredExecutablePath)
    : null;
  const installed = await (deps.listInstalled ?? listInstalledDedicatedBrowsers)();
  const installedExecutableRealpaths: string[] = [];
  const installedBuildIds: Record<string, string> = {};
  for (const entry of installed) {
    const executableRealpath = await canonicalizePath(entry.executablePath);
    installedExecutableRealpaths.push(executableRealpath);
    installedBuildIds[executableRealpath] = entry.buildId;
  }
  if (
    configuredExecutableRealpath &&
    !installedExecutableRealpaths.includes(configuredExecutableRealpath)
  ) {
    installedExecutableRealpaths.unshift(configuredExecutableRealpath);
  }
  const receipt = await (deps.readReceipt ?? readDedicatedBrowserRuntimeReceipt)(profileDir);
  const recordedPid = await (deps.readPid ?? readChromePid)(profileDir);
  const recordedPort = await (deps.readPort ?? readDevToolsPort)(profileDir);
  const staleLockPresent = (
    await Promise.all(
      STALE_LOCK_FILENAMES.map((filename) =>
        lstat(path.join(profileDir, filename))
          .then(() => true)
          .catch(() => false),
      ),
    )
  ).some(Boolean);
  const profileProcess = await (deps.findProfileProcess ?? findRunningChromeForProfile)(profileDir);
  const knownExecutables = [
    ...installedExecutableRealpaths,
    ...(receipt?.executableRealpath ? [receipt.executableRealpath] : []),
  ];
  // The runtime receipt is exact root-process evidence. Chromium helpers can
  // inherit both the profile and CDP switches and may appear first in `ps`
  // after PID rollover, so never let an arbitrary discovery override a live
  // matching receipt root. If it is gone, fall back to the discovered process
  // and finally the legacy pid file; classification below still fails closed
  // on any receipt, start-time, executable, profile, or port conflict.
  const candidatePids = [receipt?.pid, profileProcess?.pid, recordedPid].filter(
    validPositiveInteger,
  );
  let observed: ObservedProcess | null = null;
  for (const candidatePid of new Set(candidatePids)) {
    const candidate = await (deps.observeProcess ?? observeProcess)(candidatePid, knownExecutables);
    if (
      candidate &&
      processCommandUsesAnyProfile(candidate.command, [profileDir, profileRealpath])
    ) {
      observed = candidate;
      break;
    }
  }
  const debugPort =
    receipt && observed?.pid === receipt.pid
      ? receipt.debugPort
      : (profileProcess?.port ?? receipt?.debugPort ?? recordedPort);
  const endpoint = debugPort
    ? await (deps.probe ?? verifyDevToolsReachable)({
        port: debugPort,
        host: "127.0.0.1",
        attempts: 1,
        timeoutMs: 750,
      })
    : ({ ok: false, error: "missing" } as const);
  const endpointReachable = endpoint.ok;
  const metadataDrift = Boolean(
    (observed && recordedPid !== observed.pid) ||
    (debugPort && recordedPort !== debugPort) ||
    (receipt && observed && receipt.pid !== observed.pid) ||
    (receipt && debugPort && receipt.debugPort !== debugPort),
  );

  if (!observed) {
    if (endpointReachable) {
      return {
        state: "ambiguous",
        ownership: "foreign-or-ambiguous",
        profileDir,
        profileRealpath,
        configuredExecutablePath,
        configuredExecutableRealpath,
        installedExecutableRealpaths,
        installedBuildIds,
        recordedPid,
        recordedPort,
        observed: null,
        debugPort: debugPort ?? null,
        endpointReachable,
        receipt,
        metadataDrift,
        reason: "A live DevTools endpoint exists but its exact profile owner cannot be proved.",
      };
    }
    const stale = metadataExists({ recordedPid, recordedPort, receipt, staleLockPresent });
    return {
      state: stale ? "stale-metadata" : "absent",
      ownership: null,
      profileDir,
      profileRealpath,
      configuredExecutablePath,
      configuredExecutableRealpath,
      installedExecutableRealpaths,
      installedBuildIds,
      recordedPid,
      recordedPort,
      observed: null,
      debugPort: debugPort ?? null,
      endpointReachable,
      receipt,
      metadataDrift,
      reason: stale
        ? "No dedicated browser owns the profile; recorded process metadata is stale."
        : "No dedicated browser is running.",
    };
  }

  if (!debugPort) {
    return {
      state: "ambiguous",
      ownership: "foreign-or-ambiguous",
      profileDir,
      profileRealpath,
      configuredExecutablePath,
      configuredExecutableRealpath,
      installedExecutableRealpaths,
      installedBuildIds,
      recordedPid,
      recordedPort,
      observed,
      debugPort: null,
      endpointReachable: false,
      receipt,
      metadataDrift,
      reason: "A browser owns the profile but its loopback DevTools endpoint is unknown.",
    };
  }
  const ownership = classifyDedicatedChromeOwnership({
    observed,
    profileRealpath,
    debugPort,
    configuredExecutableRealpath,
    installedExecutableRealpaths,
    receipt,
    profilePathAliases: [profileDir],
  });
  if (ownership === "foreign-or-ambiguous") {
    return {
      state: "ambiguous",
      ownership,
      profileDir,
      profileRealpath,
      configuredExecutablePath,
      configuredExecutableRealpath,
      installedExecutableRealpaths,
      installedBuildIds,
      recordedPid,
      recordedPort,
      observed,
      debugPort,
      endpointReachable,
      receipt,
      metadataDrift,
      reason: "The profile owner is foreign or its process identity evidence conflicts.",
    };
  }
  const state = endpointReachable
    ? ownership === "managed-current"
      ? "healthy-current"
      : "healthy-managed-compatible"
    : "unreachable-managed";
  return {
    state,
    ownership,
    profileDir,
    profileRealpath,
    configuredExecutablePath,
    configuredExecutableRealpath,
    installedExecutableRealpaths,
    installedBuildIds,
    recordedPid,
    recordedPort,
    observed,
    debugPort,
    endpointReachable,
    receipt,
    metadataDrift,
    reason: endpointReachable
      ? ownership === "managed-current"
        ? "The current managed Chrome for Testing generation is healthy."
        : "A compatible managed Chrome for Testing generation is healthy."
      : "The managed browser process exists but its DevTools endpoint is unreachable.",
  };
}

export function planDedicatedChromeAction(input: {
  state: DedicatedChromeState;
  mode: DedicatedChromeActionMode;
  protectedState: boolean;
}): DedicatedChromePlan {
  if (input.state === "ambiguous") {
    return {
      action: "block-human-action",
      reason: "The dedicated profile owner cannot be verified.",
    };
  }
  if (input.mode === "acquire") {
    switch (input.state) {
      case "absent":
        return { action: "launch-current", reason: "No dedicated browser is running." };
      case "stale-metadata":
        return {
          action: "clear-stale-metadata-and-launch",
          reason: "Stale runtime metadata can be cleared before launch.",
        };
      case "healthy-current":
        return { action: "reuse-current", reason: "The current generation is healthy." };
      case "healthy-managed-compatible":
        return {
          action: "reuse-compatible-and-defer-rollover",
          reason: "The healthy old managed generation can finish this operation.",
        };
      case "unreachable-managed":
      case "orphan-managed":
        if (input.protectedState) {
          return {
            action: "preserve-protected",
            reason: "Active or recoverable browser work must survive process maintenance.",
          };
        }
        return {
          action: "terminate-managed-and-launch-current",
          reason: "The verified managed process is unusable and can be replaced before dispatch.",
        };
      case "protected-managed":
        return {
          action: "preserve-protected",
          reason: "Protected work retains its existing browser generation.",
        };
      default:
        return { action: "block-human-action", reason: "Browser state is not repairable." };
    }
  }
  if (input.protectedState && input.state !== "absent" && input.state !== "stale-metadata") {
    return {
      action: "preserve-protected",
      reason: "Active or recoverable browser work must survive process maintenance.",
    };
  }
  if (input.state === "absent") {
    return { action: "no-op", reason: "No dedicated browser is running." };
  }
  if (input.state === "stale-metadata") {
    return { action: "clear-stale-metadata", reason: "Only stale runtime metadata remains." };
  }
  if (
    input.state === "healthy-current" ||
    input.state === "healthy-managed-compatible" ||
    input.state === "unreachable-managed" ||
    input.state === "orphan-managed"
  ) {
    return {
      action: "terminate-managed",
      reason: "The verified managed browser is idle and can drain safely.",
    };
  }
  return { action: "preserve-protected", reason: "The browser is protected." };
}

export async function clearDedicatedChromeMetadata(profileDir: string): Promise<void> {
  const targets = [
    runtimeReceiptPath(profileDir),
    path.join(profileDir, CHROME_PID_FILENAME),
    ...getDevToolsActivePortPaths(profileDir),
    ...STALE_LOCK_FILENAMES.map((filename) => path.join(profileDir, filename)),
  ];
  for (const target of targets) {
    await rm(target, { force: true }).catch(() => undefined);
  }
}

function buildReceipt(
  inspection: DedicatedChromeInspection,
  options: {
    launchedAt?: string;
    rolloverPending?: boolean;
    holdReason?: string;
    holdExpiresAt?: string;
  } = {},
): DedicatedBrowserRuntimeReceipt {
  const observed = inspection.observed;
  const port = inspection.debugPort;
  if (!observed?.processStartTime || !port) {
    throw new Error(
      "Dedicated browser process identity is incomplete; runtime receipt not written.",
    );
  }
  const executableRealpath =
    observed.executableRealpath ??
    observed.executablePath ??
    inspection.receipt?.executableRealpath ??
    inspection.configuredExecutableRealpath;
  if (!executableRealpath) {
    throw new Error(
      "Dedicated browser executable identity is unavailable; runtime receipt not written.",
    );
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    pid: observed.pid,
    processStartTime: observed.processStartTime,
    profileRealpath: inspection.profileRealpath,
    executableRealpath,
    buildId: inspection.installedBuildIds[executableRealpath],
    platform: process.platform,
    debugHost: "127.0.0.1",
    debugPort: port,
    launchedAt: options.launchedAt ?? inspection.receipt?.launchedAt ?? now,
    lastVerifiedAt: now,
    rolloverPending: options.rolloverPending || undefined,
    controllerPid: process.pid,
    holdReason: options.holdReason,
    holdExpiresAt: options.holdExpiresAt,
  };
}

async function persistReusableChrome(
  inspection: DedicatedChromeInspection,
  writeReceipt: typeof writeDedicatedBrowserRuntimeReceipt,
  rolloverPending: boolean,
): Promise<LaunchedChrome & { host?: string }> {
  if (!inspection.observed || !inspection.debugPort) {
    throw new Error("Reusable dedicated browser identity is incomplete.");
  }
  await writeChromePid(inspection.profileDir, inspection.observed.pid);
  await writeDevToolsActivePort(inspection.profileDir, inspection.debugPort);
  await writeReceipt(inspection.profileDir, buildReceipt(inspection, { rolloverPending }));
  const expected = inspection;
  return {
    pid: inspection.observed.pid,
    port: inspection.debugPort,
    process: undefined,
    host: "127.0.0.1",
    remoteDebuggingPipes: undefined,
    kill: async () => {
      const result = await terminateVerifiedDedicatedChrome({ inspection: expected });
      if (result.status !== "complete") {
        throw new Error(result.error ?? "Dedicated Chrome did not terminate cleanly.");
      }
    },
  } as unknown as LaunchedChrome & { host?: string };
}

function unverifiedOwnerError(inspection: DedicatedChromeInspection): BrowserAutomationError {
  return new BrowserAutomationError(
    "Oracle found an unverified browser using its dedicated profile. The review was not sent. Close that Oracle browser window once, then retry.",
    {
      stage: "dedicated-browser-heal",
      code: "dedicated-browser-owner-unverified",
      promptSubmitted: false,
      externalDataSent: false,
      repairAttempted: false,
      repairOutcome: "blocked-ambiguous-owner",
      retrySafe: true,
      diagnostics: {
        state: inspection.state,
        pid: inspection.observed?.pid ?? inspection.recordedPid,
        port: inspection.debugPort ?? inspection.recordedPort,
        reason: inspection.reason,
      },
    },
  );
}

async function inspectDedicatedChromeProtection(
  profileDir: string,
  currentLeaseId: string | undefined,
  deps: Pick<AcquireDeps, "readRegistry" | "processAlive">,
): Promise<{ protectedState: boolean; activeLeases: number; protectedTargets: number }> {
  const registry = await (deps.readRegistry ?? readBrowserTargetRegistry)(profileDir);
  const alive = deps.processAlive ?? isProcessAlive;
  const activeLeases = registry.leases.filter(
    (lease) => lease.id !== currentLeaseId && alive(lease.pid),
  ).length;
  const now = Date.now();
  const protectedTargets = registry.targets.filter((target) => {
    if (target.disposition === "active") return true;
    if (target.disposition !== "recoverable") return false;
    const expiry = Date.parse(target.recoveryExpiresAt ?? "");
    return !Number.isFinite(expiry) || expiry > now;
  }).length;
  return {
    protectedState: activeLeases > 0 || protectedTargets > 0,
    activeLeases,
    protectedTargets,
  };
}

function protectedBrowserError(protection: {
  activeLeases: number;
  protectedTargets: number;
}): BrowserAutomationError {
  return new BrowserAutomationError(
    "Oracle preserved an active or recoverable consultation in its dedicated browser. The new review was not sent. Recover or finish the existing session, then retry.",
    {
      stage: "dedicated-browser-heal",
      code: "dedicated-browser-protected",
      promptSubmitted: false,
      externalDataSent: false,
      repairAttempted: false,
      repairOutcome: "preserved-active-or-recoverable",
      retrySafe: true,
      diagnostics: protection,
    },
  );
}

async function inspectAfterLaunch(
  input: { profileDir: string; chromePath?: string | null },
  launched: LaunchedChrome,
  deps: InspectDeps & { wait?: (ms: number) => Promise<void> },
): Promise<DedicatedChromeInspection> {
  const wait = deps.wait ?? delay;
  if (launched.pid) await writeChromePid(input.profileDir, launched.pid);
  if (launched.port) await writeDevToolsActivePort(input.profileDir, launched.port);
  let inspection = await inspectDedicatedChromeState(input, deps);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      inspection.observed?.pid === launched.pid &&
      inspection.debugPort === launched.port &&
      inspection.endpointReachable &&
      inspection.ownership !== "foreign-or-ambiguous"
    ) {
      return inspection;
    }
    await wait(50);
    inspection = await inspectDedicatedChromeState(input, deps);
  }
  return inspection;
}

export async function acquireDedicatedChromeForRun(
  input: {
    profileDir: string;
    config: ResolvedBrowserConfig;
    logger: BrowserLogger;
    sessionId?: string;
    currentLeaseId?: string;
  },
  deps: AcquireDeps = {},
): Promise<DedicatedChromeAcquireResult> {
  const profileDir = normalizeIdentityPath(input.profileDir);
  const lockTimeoutMs = Math.max(0, input.config.profileLockTimeoutMs ?? 0);
  let lock: ProfileRunLock | null = null;
  if (lockTimeoutMs > 0) {
    lock = await (deps.acquireLock ?? acquireProfileRunLock)(profileDir, {
      timeoutMs: lockTimeoutMs,
      logger: input.logger.verbose ? input.logger : undefined,
      sessionId: input.sessionId,
    });
  }
  const inspectInput = { profileDir, chromePath: input.config.chromePath };
  const inspectDeps: InspectDeps = deps;
  const writeReceipt = deps.writeReceipt ?? writeDedicatedBrowserRuntimeReceipt;
  let repairAttempted = false;
  try {
    if ((input.config.reuseChromeWaitMs ?? 0) > 0 && !(await readDevToolsPort(profileDir))) {
      const deadline = Date.now() + input.config.reuseChromeWaitMs;
      while (Date.now() < deadline && !(await readDevToolsPort(profileDir))) {
        await (deps.wait ?? delay)(250);
      }
    }
    let inspection = await inspectDedicatedChromeState(inspectInput, inspectDeps);
    let protection = await inspectDedicatedChromeProtection(profileDir, input.currentLeaseId, deps);
    let plan = planDedicatedChromeAction({
      state: inspection.state,
      mode: "acquire",
      protectedState: protection.protectedState,
    });

    if (plan.action === "block-human-action") {
      throw unverifiedOwnerError(inspection);
    }
    if (plan.action === "preserve-protected") throw protectedBrowserError(protection);
    if (plan.action === "reuse-current" || plan.action === "reuse-compatible-and-defer-rollover") {
      const chrome = await persistReusableChrome(
        inspection,
        writeReceipt,
        plan.action === "reuse-compatible-and-defer-rollover",
      );
      input.logger.sessionLog?.(
        `[browser] Dedicated Chrome ${plan.action === "reuse-current" ? "reused" : "reused with rollover pending"}.`,
      );
      return {
        chrome,
        reusedChrome: chrome,
        bootstrap: {
          action: plan.action,
          repairAttempted: false,
          repairOutcome: "reused",
          rolloverPending: plan.action === "reuse-compatible-and-defer-rollover",
        },
      };
    }

    if (
      plan.action === "clear-stale-metadata-and-launch" ||
      plan.action === "terminate-managed-and-launch-current"
    ) {
      repairAttempted = true;
      input.logger("Repairing Oracle’s dedicated browser…");
      if (plan.action === "clear-stale-metadata-and-launch") {
        await (deps.clearMetadata ?? clearDedicatedChromeMetadata)(profileDir);
      } else {
        const termination = await (deps.terminate ?? terminateVerifiedDedicatedChrome)(
          { inspection, logger: input.logger },
          deps,
        );
        if (termination.status !== "complete") {
          throw new BrowserAutomationError(
            "Oracle could not safely repair its dedicated browser. The review was not sent.",
            {
              stage: "dedicated-browser-heal",
              code: "dedicated-browser-repair-failed",
              promptSubmitted: false,
              externalDataSent: false,
              repairAttempted: true,
              repairOutcome: termination.status,
              retrySafe: true,
              termination,
            },
          );
        }
      }
      inspection = await inspectDedicatedChromeState(inspectInput, inspectDeps);
      protection = await inspectDedicatedChromeProtection(profileDir, input.currentLeaseId, deps);
      plan = planDedicatedChromeAction({
        state: inspection.state,
        mode: "acquire",
        protectedState: protection.protectedState,
      });
      if (plan.action === "block-human-action") throw unverifiedOwnerError(inspection);
      if (plan.action === "preserve-protected") throw protectedBrowserError(protection);
      if (plan.action !== "launch-current") {
        throw new BrowserAutomationError(
          "Oracle’s dedicated browser state remained inconsistent after one safe repair. The review was not sent.",
          {
            stage: "dedicated-browser-heal",
            code: "dedicated-browser-repair-not-converged",
            promptSubmitted: false,
            externalDataSent: false,
            repairAttempted: true,
            repairOutcome: inspection.state,
            retrySafe: true,
          },
        );
      }
    }

    const configuredExecutable = inspection.configuredExecutablePath;
    const launchedAt = new Date().toISOString();
    const chrome = await (deps.launch ?? launchChrome)(
      {
        ...input.config,
        chromePath: configuredExecutable ?? input.config.chromePath,
        remoteChrome: null,
      },
      profileDir,
      input.logger,
    );
    const launchedInspection = await inspectAfterLaunch(inspectInput, chrome, {
      ...inspectDeps,
      wait: deps.wait,
    });
    if (
      !launchedInspection.observed ||
      launchedInspection.observed.pid !== chrome.pid ||
      launchedInspection.debugPort !== chrome.port ||
      !launchedInspection.endpointReachable ||
      launchedInspection.ownership === "foreign-or-ambiguous"
    ) {
      await Promise.resolve(chrome.kill()).catch(() => undefined);
      throw new BrowserAutomationError(
        "Oracle launched its dedicated browser but could not verify the resulting process. The review was not sent.",
        {
          stage: "dedicated-browser-heal",
          code: "dedicated-browser-launch-unverified",
          promptSubmitted: false,
          externalDataSent: false,
          repairAttempted,
          repairOutcome: "launch-unverified",
          retrySafe: true,
        },
      );
    }
    await writeReceipt(
      profileDir,
      buildReceipt(launchedInspection, { launchedAt, rolloverPending: false }),
    );
    return {
      chrome,
      reusedChrome: null,
      bootstrap: {
        action: "launch-current",
        repairAttempted,
        repairOutcome: repairAttempted ? "repaired-and-launched" : "launched",
        rolloverPending: false,
      },
    };
  } catch (error) {
    const existing = error instanceof BrowserAutomationError ? error : null;
    const message = error instanceof Error ? error.message : String(error);
    throw new BrowserAutomationError(
      /review was not sent/iu.test(message) ? message : `${message} The review was not sent.`,
      {
        ...(existing?.details ?? {}),
        stage: existing?.details?.stage ?? "dedicated-browser-heal",
        promptSubmitted: false,
        externalDataSent: false,
        repairAttempted:
          typeof existing?.details?.repairAttempted === "boolean"
            ? existing.details.repairAttempted
            : repairAttempted,
        repairOutcome: existing?.details?.repairOutcome ?? "bootstrap-failed",
        retrySafe: existing?.details?.retrySafe ?? true,
      },
      error,
    );
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

export async function closeDedicatedChromeOverCdp(port: number, host = "127.0.0.1"): Promise<void> {
  const version = (await CDP.Version({ host, port })) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not expose a browser WebSocket endpoint.");
  }
  const client = await CDP({ target: version.webSocketDebuggerUrl, local: true });
  try {
    await client.Browser.close();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function processAndEndpointStopped(
  pid: number,
  port: number,
  processFamily: DedicatedChromeProcessFamilyMember[],
  deps: TerminateDeps,
): Promise<{
  processExited: boolean;
  processFamilyExited: boolean;
  endpointClosed: boolean;
}> {
  const processExited = !(deps.alive ?? isProcessAlive)(pid);
  const familyState = await inspectCapturedProcessFamily(processFamily, deps);
  const endpoint = await (deps.probe ?? verifyDevToolsReachable)({
    port,
    host: "127.0.0.1",
    attempts: 1,
    timeoutMs: 250,
  });
  return {
    processExited,
    processFamilyExited: familyState.remaining.length === 0,
    endpointClosed: !endpoint.ok,
  };
}

async function waitForDedicatedChromeStop(
  pid: number,
  port: number,
  processFamily: DedicatedChromeProcessFamilyMember[],
  timeoutMs: number,
  deps: TerminateDeps,
): Promise<{
  processExited: boolean;
  processFamilyExited: boolean;
  endpointClosed: boolean;
}> {
  const deadline = Date.now() + timeoutMs;
  let state = await processAndEndpointStopped(pid, port, processFamily, deps);
  while (
    (!state.processExited || !state.processFamilyExited || !state.endpointClosed) &&
    Date.now() < deadline
  ) {
    await (deps.wait ?? delay)(100);
    state = await processAndEndpointStopped(pid, port, processFamily, deps);
  }
  return state;
}

async function captureVerifiedProcessFamily(
  root: ObservedProcess,
  deps: TerminateDeps,
): Promise<DedicatedChromeProcessFamilyMember[]> {
  const fallback: DedicatedChromeProcessFamilyMember = {
    pid: root.pid,
    ppid: root.ppid,
    processStartTime: root.processStartTime ?? "",
    command: root.command,
    depth: 0,
  };
  const processes = await (deps.listProcesses ?? listObservedProcesses)().catch(() => []);
  const listedRoot = processes.find(
    (candidate) =>
      candidate.pid === root.pid &&
      candidate.processStartTime &&
      candidate.processStartTime === root.processStartTime,
  );
  if (!listedRoot?.processStartTime) return [fallback];

  const children = new Map<number, ObservedProcess[]>();
  for (const processEntry of processes) {
    if (!processEntry.ppid || !processEntry.processStartTime) continue;
    const siblings = children.get(processEntry.ppid) ?? [];
    siblings.push(processEntry);
    children.set(processEntry.ppid, siblings);
  }
  const family: DedicatedChromeProcessFamilyMember[] = [];
  const queue: Array<{ processEntry: ObservedProcess; depth: number }> = [
    { processEntry: listedRoot, depth: 0 },
  ];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next?.processEntry.processStartTime || seen.has(next.processEntry.pid)) continue;
    seen.add(next.processEntry.pid);
    family.push({
      pid: next.processEntry.pid,
      ppid: next.processEntry.ppid,
      processStartTime: next.processEntry.processStartTime,
      command: next.processEntry.command,
      depth: next.depth,
    });
    for (const child of children.get(next.processEntry.pid) ?? []) {
      queue.push({ processEntry: child, depth: next.depth + 1 });
    }
  }
  return family.length > 0 ? family : [fallback];
}

async function inspectCapturedProcessFamily(
  processFamily: DedicatedChromeProcessFamilyMember[],
  deps: TerminateDeps,
): Promise<{ identityVerified: boolean; remaining: DedicatedChromeProcessFamilyMember[] }> {
  const alive = deps.alive ?? isProcessAlive;
  const observe = deps.observeProcess ?? observeProcess;
  const remaining: DedicatedChromeProcessFamilyMember[] = [];
  for (const member of processFamily) {
    if (!alive(member.pid)) continue;
    const current = await observe(member.pid);
    if (!current?.processStartTime) {
      return { identityVerified: false, remaining };
    }
    if (current.processStartTime === member.processStartTime) {
      remaining.push(member);
    }
    // A live PID with another start time is a reused PID. The captured Chrome
    // process exited, and the replacement must never receive a signal.
  }
  return { identityVerified: true, remaining };
}

async function revalidateTerminationFamily(
  expected: DedicatedChromeInspection,
  processFamily: DedicatedChromeProcessFamilyMember[],
  deps: TerminateDeps,
): Promise<boolean> {
  const rootPid = expected.observed?.pid;
  if (!rootPid) return false;
  if ((deps.alive ?? isProcessAlive)(rootPid)) {
    if (!(await revalidateTerminationOwnership(expected, deps))) return false;
  }
  return (await inspectCapturedProcessFamily(processFamily, deps)).identityVerified;
}

async function signalVerifiedProcessFamily(
  processFamily: DedicatedChromeProcessFamilyMember[],
  signal: NodeJS.Signals,
  deps: TerminateDeps,
): Promise<string | undefined> {
  const state = await inspectCapturedProcessFamily(processFamily, deps);
  if (!state.identityVerified) {
    return "Captured Chrome process-family identity changed before signal escalation.";
  }
  let lastError: string | undefined;
  for (const member of state.remaining.sort((left, right) => left.depth - right.depth)) {
    try {
      (deps.sendSignal ?? process.kill)(member.pid, signal);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return lastError;
}

async function revalidateTerminationOwnership(
  expected: DedicatedChromeInspection,
  deps: TerminateDeps,
): Promise<boolean> {
  const current = await inspectDedicatedChromeState(
    { profileDir: expected.profileDir, chromePath: expected.configuredExecutablePath },
    deps,
  );
  return Boolean(
    current.observed &&
    expected.observed &&
    current.observed.pid === expected.observed.pid &&
    current.observed.processStartTime &&
    current.observed.processStartTime === expected.observed.processStartTime &&
    current.debugPort === expected.debugPort &&
    (current.ownership === "managed-current" || current.ownership === "managed-compatible"),
  );
}

export async function terminateVerifiedDedicatedChrome(
  input: { inspection: DedicatedChromeInspection; logger?: BrowserLogger },
  deps: TerminateDeps = {},
): Promise<DedicatedChromeTerminationReceipt> {
  const startedAt = new Date().toISOString();
  const expected = input.inspection;
  const pid = expected.observed?.pid ?? 0;
  const port = expected.debugPort ?? 0;
  const processFamily = expected.observed
    ? await captureVerifiedProcessFamily(expected.observed, deps)
    : [];
  const base = {
    pid,
    debugPort: port,
    startedAt,
    completedAt: new Date().toISOString(),
    ownershipRevalidated: false,
    processExited: false,
    processFamilyPids: processFamily.map((member) => member.pid),
    processFamilyExited: false,
    endpointClosed: false,
    metadataCleared: false,
  };
  if (
    !pid ||
    !port ||
    !expected.observed?.processStartTime ||
    (expected.ownership !== "managed-current" && expected.ownership !== "managed-compatible")
  ) {
    return { ...base, status: "blocked", error: "Managed process ownership is incomplete." };
  }
  if (!(await revalidateTerminationOwnership(expected, deps))) {
    return {
      ...base,
      status: "blocked",
      error: "Managed process ownership changed before termination.",
    };
  }

  let method: DedicatedChromeTerminationReceipt["method"];
  let lastError: string | undefined;
  try {
    await (deps.closeOverCdp ?? closeDedicatedChromeOverCdp)(port, "127.0.0.1");
    method = "cdp";
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  let stopped = await waitForDedicatedChromeStop(pid, port, processFamily, CDP_CLOSE_WAIT_MS, deps);
  if (!stopped.processExited || !stopped.processFamilyExited || !stopped.endpointClosed) {
    if (!(await revalidateTerminationFamily(expected, processFamily, deps))) {
      return {
        ...base,
        status: "blocked",
        method,
        ...stopped,
        error: "Managed process ownership changed before SIGTERM escalation.",
      };
    }
    lastError = await signalVerifiedProcessFamily(processFamily, "SIGTERM", deps);
    method = "sigterm";
    stopped = await waitForDedicatedChromeStop(pid, port, processFamily, SIGTERM_WAIT_MS, deps);
  }
  if (!stopped.processExited || !stopped.processFamilyExited || !stopped.endpointClosed) {
    if (!(await revalidateTerminationFamily(expected, processFamily, deps))) {
      return {
        ...base,
        status: "blocked",
        method,
        ...stopped,
        error: "Managed process ownership changed before SIGKILL escalation.",
      };
    }
    lastError = await signalVerifiedProcessFamily(processFamily, "SIGKILL", deps);
    method = "sigkill";
    stopped = await waitForDedicatedChromeStop(
      pid,
      port,
      processFamily,
      SIGKILL_CONFIRM_WAIT_MS,
      deps,
    );
  }
  if (!stopped.processExited || !stopped.processFamilyExited || !stopped.endpointClosed) {
    return {
      ...base,
      status: "failed",
      method,
      ownershipRevalidated: true,
      ...stopped,
      error: lastError ?? "Dedicated Chrome remained alive after verified termination escalation.",
    };
  }
  await (deps.clearMetadata ?? clearDedicatedChromeMetadata)(expected.profileDir);
  input.logger?.sessionLog?.(
    `[browser] Dedicated Chrome drained via ${method ?? "observed shutdown"}.`,
  );
  return {
    ...base,
    status: "complete",
    method,
    completedAt: new Date().toISOString(),
    ownershipRevalidated: true,
    processExited: true,
    processFamilyExited: true,
    endpointClosed: true,
    metadataCleared: true,
  };
}

export async function recordDedicatedChromeHold(
  profileDir: string,
  reason: string,
  expiresAt?: string,
): Promise<void> {
  const receipt = await readDedicatedBrowserRuntimeReceipt(profileDir);
  if (!receipt) return;
  await writeDedicatedBrowserRuntimeReceipt(profileDir, {
    ...receipt,
    lastVerifiedAt: new Date().toISOString(),
    holdReason: reason,
    holdExpiresAt: expiresAt,
  });
}

async function maintainDedicatedChrome(
  input: {
    profileDir: string;
    chromePath?: string | null;
    logger: BrowserLogger;
    mode: "heal" | "drain";
    protectedState?: boolean;
    protectedReason?: string;
    protectedUntil?: string;
    planOnly?: boolean;
    lockHeld?: boolean;
    lockTimeoutMs?: number;
  },
  deps: AcquireDeps = {},
): Promise<DedicatedChromeMaintenanceReceipt> {
  let lock: ProfileRunLock | null = null;
  if (!input.lockHeld && (input.lockTimeoutMs ?? 0) > 0) {
    lock = await (deps.acquireLock ?? acquireProfileRunLock)(input.profileDir, {
      timeoutMs: input.lockTimeoutMs ?? 0,
      logger: input.logger.verbose ? input.logger : undefined,
    });
  }
  try {
    const inspection = await inspectDedicatedChromeState(
      { profileDir: input.profileDir, chromePath: input.chromePath },
      deps,
    );
    const protectedState = Boolean(input.protectedState);
    const plan = planDedicatedChromeAction({
      state: inspection.state,
      mode: input.mode,
      protectedState,
    });
    if (input.planOnly) {
      return {
        mode: input.mode,
        planOnly: true,
        action: plan.action,
        stateBefore: inspection.state,
        changed: false,
        protectedState,
        reason: plan.reason,
      };
    }
    if (plan.action === "preserve-protected") {
      await recordDedicatedChromeHold(
        inspection.profileDir,
        input.protectedReason ?? plan.reason,
        input.protectedUntil,
      );
      return {
        mode: input.mode,
        planOnly: false,
        action: plan.action,
        stateBefore: inspection.state,
        stateAfter: inspection.state,
        changed: false,
        protectedState,
        reason: plan.reason,
      };
    }
    if (plan.action === "block-human-action" || plan.action === "no-op") {
      return {
        mode: input.mode,
        planOnly: false,
        action: plan.action,
        stateBefore: inspection.state,
        stateAfter: inspection.state,
        changed: false,
        protectedState,
        reason: plan.reason,
      };
    }
    if (plan.action === "clear-stale-metadata") {
      await (deps.clearMetadata ?? clearDedicatedChromeMetadata)(inspection.profileDir);
      const after = await inspectDedicatedChromeState(
        { profileDir: inspection.profileDir, chromePath: input.chromePath },
        deps,
      );
      return {
        mode: input.mode,
        planOnly: false,
        action: plan.action,
        stateBefore: inspection.state,
        stateAfter: after.state,
        changed: true,
        protectedState,
        reason: plan.reason,
      };
    }
    if (plan.action === "terminate-managed") {
      const termination = await (deps.terminate ?? terminateVerifiedDedicatedChrome)(
        { inspection, logger: input.logger },
        deps,
      );
      const after = await inspectDedicatedChromeState(
        { profileDir: inspection.profileDir, chromePath: input.chromePath },
        deps,
      );
      return {
        mode: input.mode,
        planOnly: false,
        action: plan.action,
        stateBefore: inspection.state,
        stateAfter: after.state,
        changed: termination.status === "complete",
        protectedState,
        reason: termination.error ?? plan.reason,
        termination,
      };
    }
    return {
      mode: input.mode,
      planOnly: false,
      action: plan.action,
      stateBefore: inspection.state,
      stateAfter: inspection.state,
      changed: false,
      protectedState,
      reason: plan.reason,
    };
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

export async function healDedicatedChrome(
  input: Omit<Parameters<typeof maintainDedicatedChrome>[0], "mode">,
  deps: AcquireDeps = {},
): Promise<DedicatedChromeMaintenanceReceipt> {
  return maintainDedicatedChrome({ ...input, mode: "heal" }, deps);
}

export async function drainDedicatedChromeIfIdle(
  input: Omit<Parameters<typeof maintainDedicatedChrome>[0], "mode" | "planOnly">,
  deps: AcquireDeps = {},
): Promise<DedicatedChromeMaintenanceReceipt> {
  return maintainDedicatedChrome({ ...input, mode: "drain", planOnly: false }, deps);
}
