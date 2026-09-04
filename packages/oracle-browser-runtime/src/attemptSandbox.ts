import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  link,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  authSeedCloneSourceGeneration,
  getCurrentProcessStartTime,
  observeLocalProcessStartTime,
  validateAuthSeedCloneSource,
  withAuthSeedCloneLock,
  type AuthSeedCloneSource,
} from "./authSeed.js";
import { withBrowserLockMutation } from "./lockMutation.js";
import {
  closeManagedBrowserOverCdp,
  findManagedBrowserProcessesUsingProfile,
  managedBrowserProcessMatchesReceipt,
  observeManagedBrowserProcess,
  type ProcessIdentityDependencies,
} from "./processIdentity.js";
import type {
  AttemptProcessReceipt,
  AttemptSandbox,
  AttemptSandboxCleanupReceipt,
  AttemptSandboxOwner,
  AttemptSandboxPurpose,
  ManagedBrowserProcessIdentity,
} from "./types.js";

const ATTEMPTS_DIRECTORY = "attempts";
const QUARANTINE_DIRECTORY = "quarantine";
const OWNER_RECEIPT = "owner.json";
const PROCESS_RECEIPT = "process.json";
const PROCESS_LIFECYCLE_RESERVATION = "process-lifecycle.json";
const ATTEMPT_SHELLS_DIRECTORY = "attempt-shells";

interface AttemptProcessLifecycleReservation {
  schemaVersion: "oracle.attempt-process-lifecycle.v1";
  token: string;
  jobId: string;
  turnAttemptId: string;
  pid: number;
  processStartTime: string;
  createdAt: string;
}

export interface AttemptCleanupDependencies extends ProcessIdentityDependencies {
  findProcessesUsingProfile?: typeof findManagedBrowserProcessesUsingProfile;
  closeWaitMs?: number;
  termWaitMs?: number;
  killWaitMs?: number;
}

export async function createAttemptSandbox(input: {
  runtimeRoot: string;
  seed: AuthSeedCloneSource;
  jobId: string;
  turnAttemptId: string;
  purpose: AttemptSandboxPurpose;
  copyProfile?: (source: string, destination: string) => Promise<void>;
  lockTimeoutMs?: number;
}): Promise<AttemptSandbox> {
  validateOwnerField("jobId", input.jobId);
  validateOwnerField("turnAttemptId", input.turnAttemptId);
  return withAuthSeedCloneLock(
    input.runtimeRoot,
    async () => {
      const runtimeRoot = path.resolve(input.runtimeRoot);
      const seed = await validateAuthSeedCloneSource(runtimeRoot, input.seed);
      const seedProfileRealpath = seed.profileRealpath;
      const attemptsRoot = path.join(runtimeRoot, ATTEMPTS_DIRECTORY);
      await ensurePrivateDirectory(attemptsRoot);
      const attemptsRealpath = await realpath(attemptsRoot);
      if (isPathWithin(attemptsRealpath, seedProfileRealpath)) {
        throw new Error("An attempt sandbox cannot be used as an auth-seed source");
      }
      const seedGeneration = authSeedCloneSourceGeneration(seed);
      const sandboxId = createHash("sha256")
        .update(
          JSON.stringify([
            "oracle.attempt-sandbox-owner.v1",
            input.jobId,
            input.turnAttemptId,
            input.purpose,
          ]),
        )
        .digest("hex");
      const finalDirectory = path.join(attemptsRealpath, sandboxId);
      const finalProfile = path.join(finalDirectory, "profile");
      const owner: AttemptSandboxOwner = {
        schemaVersion: "oracle.attempt-sandbox-owner.v1",
        jobId: input.jobId,
        turnAttemptId: input.turnAttemptId,
        purpose: input.purpose,
        seedGeneration,
        profileRealpath: finalProfile,
        createdAt: new Date().toISOString(),
      };
      const processStartTime = await getCurrentProcessStartTime();
      const reservation: AttemptProcessLifecycleReservation = {
        schemaVersion: "oracle.attempt-process-lifecycle.v1",
        token: randomUUID(),
        jobId: owner.jobId,
        turnAttemptId: owner.turnAttemptId,
        pid: process.pid,
        processStartTime,
        createdAt: new Date().toISOString(),
      };
      const shellsRoot = path.join(runtimeRoot, "run", ATTEMPT_SHELLS_DIRECTORY);
      await ensurePrivateDirectory(shellsRoot);
      const stagingDirectory = path.join(
        await realpath(shellsRoot),
        `${sandboxId}.${reservation.token}.tmp`,
      );
      const stagingProfile = path.join(stagingDirectory, "profile");
      await ensurePrivateDirectory(stagingProfile);
      await writeImmutablePrivateJson(path.join(stagingDirectory, OWNER_RECEIPT), owner);
      await writeExclusivePrivateJson(
        path.join(stagingDirectory, PROCESS_LIFECYCLE_RESERVATION),
        reservation,
      );
      let published = false;
      try {
        await rename(stagingDirectory, finalDirectory);
        published = true;
      } catch (error) {
        if (await pathExists(finalDirectory)) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
          throw new Error("This job, turn attempt, and purpose already own an attempt sandbox");
        }
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      try {
        await (input.copyProfile ?? copyProfileDirectory)(seedProfileRealpath, finalProfile);
        if (process.platform !== "win32") await chmod(finalProfile, 0o700);
        const sandbox = await readAttemptSandbox(finalDirectory);
        if (!sameAttemptOwner(sandbox.owner, owner)) {
          throw new Error("Created attempt sandbox does not match its immutable owner marker");
        }
        return sandbox;
      } catch (error) {
        await rm(published ? finalDirectory : stagingDirectory, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        throw error;
      } finally {
        await withBrowserLockMutation(runtimeRoot, () =>
          releaseAttemptProcessLifecycleReservation(
            path.join(finalDirectory, PROCESS_LIFECYCLE_RESERVATION),
            reservation.token,
          ),
        );
      }
    },
    { timeoutMs: input.lockTimeoutMs },
  );
}

export async function readAttemptSandbox(directory: string): Promise<AttemptSandbox> {
  const resolvedDirectory = path.resolve(directory);
  const owner = await readJson<AttemptSandboxOwner>(path.join(resolvedDirectory, OWNER_RECEIPT));
  if (!isAttemptSandboxOwner(owner)) {
    throw new Error("Attempt sandbox owner marker is missing or invalid");
  }
  const directoryRealpath = await realpath(resolvedDirectory);
  if (path.basename(path.dirname(directoryRealpath)) !== ATTEMPTS_DIRECTORY) {
    throw new Error("Attempt sandbox must be one exact child of an attempts directory");
  }
  const profileDir = await realpath(path.join(directoryRealpath, "profile"));
  if (profileDir !== owner.profileRealpath) {
    throw new Error("Attempt sandbox profile path does not match its owner marker");
  }
  return {
    sandboxId: path.basename(directoryRealpath),
    directory: directoryRealpath,
    profileDir,
    owner,
  };
}

export async function writeAttemptProcessReceipt(
  sandbox: AttemptSandbox,
  identity: ManagedBrowserProcessIdentity,
): Promise<AttemptProcessReceipt> {
  const current = await readAttemptSandbox(sandbox.directory);
  if (!sameAttemptOwner(current.owner, sandbox.owner)) {
    throw new Error("Attempt sandbox ownership changed before process receipt creation");
  }
  if (identity.profileRealpath !== current.profileDir) {
    throw new Error("Managed process profile does not match its attempt sandbox");
  }
  const receipt: AttemptProcessReceipt = {
    schemaVersion: "oracle.attempt-process.v1",
    jobId: current.owner.jobId,
    turnAttemptId: current.owner.turnAttemptId,
    profileRealpath: current.profileDir,
    executableRealpath: identity.executableRealpath,
    pid: identity.pid,
    processStartTime: identity.processStartTime,
    debugHost: "127.0.0.1",
    debugPort: identity.debugPort,
    startedAt: new Date().toISOString(),
  };
  await writeExclusivePrivateJson(path.join(current.directory, PROCESS_RECEIPT), receipt);
  return receipt;
}

export async function withAttemptProcessLaunchReservation<T>(
  sandbox: AttemptSandbox,
  operation: () => Promise<T>,
): Promise<T> {
  return withAttemptProcessLifecycleReservation(
    sandbox,
    async () => {
      if (await readAttemptProcessReceipt(sandbox.directory)) {
        throw new Error("An attempt sandbox already owns a receipted browser process");
      }
      return operation();
    },
    "An attempt sandbox process launch is already in progress",
  );
}

export async function withAttemptProcessLifecycleReservation<T>(
  sandbox: AttemptSandbox,
  operation: () => Promise<T>,
  busyMessage = "An attempt sandbox process lifecycle operation is already in progress",
): Promise<T> {
  const current = await readAttemptSandbox(sandbox.directory);
  if (!sameAttemptOwner(current.owner, sandbox.owner)) {
    throw new Error("Attempt sandbox ownership changed before process lifecycle reservation");
  }
  const reservationPath = path.join(current.directory, PROCESS_LIFECYCLE_RESERVATION);
  const runtimeRoot = path.dirname(path.dirname(current.directory));
  const reservation: AttemptProcessLifecycleReservation = {
    schemaVersion: "oracle.attempt-process-lifecycle.v1",
    token: randomUUID(),
    jobId: current.owner.jobId,
    turnAttemptId: current.owner.turnAttemptId,
    pid: process.pid,
    processStartTime: await getCurrentProcessStartTime(),
    createdAt: new Date().toISOString(),
  };
  const acquired = await withBrowserLockMutation(runtimeRoot, async () => {
    try {
      await writeExclusivePrivateJson(reservationPath, reservation);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await reclaimStaleAttemptProcessLifecycleReservation(reservationPath, current.owner))) {
        return false;
      }
      await writeExclusivePrivateJson(reservationPath, reservation);
      return true;
    }
  });
  if (!acquired) throw new Error(busyMessage);
  try {
    return await operation();
  } finally {
    await withBrowserLockMutation(runtimeRoot, () =>
      releaseAttemptProcessLifecycleReservation(reservationPath, reservation.token),
    );
  }
}

export async function readAttemptProcessReceipt(
  sandboxDirectory: string,
): Promise<AttemptProcessReceipt | undefined> {
  const receipt = await readJson<AttemptProcessReceipt>(
    path.join(path.resolve(sandboxDirectory), PROCESS_RECEIPT),
  );
  if (receipt === undefined) return undefined;
  if (!isAttemptProcessReceipt(receipt)) {
    throw new Error("Attempt process receipt is invalid");
  }
  return receipt;
}

export async function cleanupAttemptSandbox(input: {
  runtimeRoot: string;
  sandboxDirectory: string;
  expectedOwner?: AttemptSandboxOwner;
  dependencies?: AttemptCleanupDependencies;
}): Promise<AttemptSandboxCleanupReceipt> {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const attemptsRoot = path.join(runtimeRoot, ATTEMPTS_DIRECTORY);
  const sandboxDirectory = path.resolve(input.sandboxDirectory);
  const sandboxId = path.basename(sandboxDirectory);
  const completed = (
    status: AttemptSandboxCleanupReceipt["status"],
    processStatus: AttemptSandboxCleanupReceipt["processStatus"],
    extra: Partial<AttemptSandboxCleanupReceipt> = {},
  ): AttemptSandboxCleanupReceipt => ({
    schemaVersion: "oracle.attempt-sandbox-cleanup.v1",
    sandboxId,
    status,
    processStatus,
    completedAt: new Date().toISOString(),
    ...extra,
  });
  if (!(await pathExists(sandboxDirectory))) {
    return completed("already-absent", "none");
  }
  try {
    const attemptsRealpath = await realpath(attemptsRoot);
    const entry = await lstat(sandboxDirectory);
    const directoryRealpath = await realpath(sandboxDirectory);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      path.dirname(directoryRealpath) !== attemptsRealpath
    ) {
      return completed("blocked", "identity-unproven", {
        error: "Attempt cleanup target is not one exact direct child of the attempts root",
      });
    }
    const sandbox = await readAttemptSandbox(directoryRealpath);
    if (input.expectedOwner && !sameAttemptOwner(sandbox.owner, input.expectedOwner)) {
      return completed("blocked", "identity-unproven", {
        error: "Attempt cleanup owner marker does not match the expected owner",
      });
    }
    return await withAttemptProcessLifecycleReservation(sandbox, async () => {
      const processReceipt = await readAttemptProcessReceipt(directoryRealpath);
      let processStatus: AttemptSandboxCleanupReceipt["processStatus"] = "none";
      if (processReceipt) {
        if (
          processReceipt.jobId !== sandbox.owner.jobId ||
          processReceipt.turnAttemptId !== sandbox.owner.turnAttemptId ||
          processReceipt.profileRealpath !== sandbox.profileDir
        ) {
          return completed("blocked", "identity-unproven", {
            error: "Attempt process receipt does not match the immutable sandbox owner",
          });
        }
        processStatus = await stopExactAttemptProcess(processReceipt, input.dependencies ?? {});
        if (processStatus === "identity-unproven") {
          return completed("blocked", processStatus, {
            error: "Attempt process identity could not be proven; no signal or deletion was issued",
          });
        }
      }
      const profileProcesses = await (
        input.dependencies?.findProcessesUsingProfile ?? findManagedBrowserProcessesUsingProfile
      )(sandbox.profileDir);
      if (profileProcesses.length > 0) {
        return completed("blocked", "identity-unproven", {
          error: processReceipt
            ? "A live process still uses the attempt profile after exact-process cleanup; no deletion was issued"
            : "Attempt sandbox has no process receipt but a live process still uses its profile; no signal or deletion was issued",
        });
      }
      if (processReceipt) {
        await rm(path.join(directoryRealpath, PROCESS_RECEIPT), { force: true });
      }
      try {
        await rm(directoryRealpath, { recursive: true, force: false });
        return completed("deleted", processStatus);
      } catch (error) {
        const quarantineRoot = path.join(runtimeRoot, QUARANTINE_DIRECTORY);
        await ensurePrivateDirectory(quarantineRoot);
        const quarantinePath = path.join(
          await realpath(quarantineRoot),
          `${sandboxId}.${randomUUID()}`,
        );
        try {
          await rename(directoryRealpath, quarantinePath);
          return completed("quarantined", processStatus, {
            quarantinePath,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (quarantineError) {
          return completed("blocked", processStatus, {
            error: `Sandbox deletion and quarantine failed: ${
              quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
            }`,
          });
        }
      }
    });
  } catch (error) {
    return completed("blocked", "identity-unproven", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listAttemptSandboxDirectories(runtimeRoot: string): Promise<string[]> {
  const attemptsRoot = path.join(path.resolve(runtimeRoot), ATTEMPTS_DIRECTORY);
  const entries = await readdir(attemptsRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(attemptsRoot, entry.name))
    .sort();
}

async function stopExactAttemptProcess(
  receipt: AttemptProcessReceipt,
  dependencies: AttemptCleanupDependencies,
): Promise<"already-stopped" | "stopped" | "identity-unproven"> {
  const observe = dependencies.observeProcess ?? observeManagedBrowserProcess;
  const initial = await observe(receipt.pid, receipt.executableRealpath);
  if (!initial || initial.processStartTime !== receipt.processStartTime) return "already-stopped";
  if (!managedBrowserProcessMatchesReceipt(initial, receipt)) return "identity-unproven";
  await (dependencies.closeOverCdp ?? closeManagedBrowserOverCdp)(receipt).catch(() => undefined);
  const afterClose = await waitForOriginalProcessExit(
    receipt,
    observe,
    dependencies.wait,
    dependencies.closeWaitMs ?? 3_000,
  );
  if (afterClose === "stopped") return "stopped";
  if (afterClose === "identity-unproven") return afterClose;
  if (!(await signalExactProcess(receipt, "SIGTERM", observe, dependencies))) {
    return "identity-unproven";
  }
  const afterTerm = await waitForOriginalProcessExit(
    receipt,
    observe,
    dependencies.wait,
    dependencies.termWaitMs ?? 3_000,
  );
  if (afterTerm === "stopped") return "stopped";
  if (afterTerm === "identity-unproven") return afterTerm;
  if (!(await signalExactProcess(receipt, "SIGKILL", observe, dependencies))) {
    return "identity-unproven";
  }
  const afterKill = await waitForOriginalProcessExit(
    receipt,
    observe,
    dependencies.wait,
    dependencies.killWaitMs ?? 2_000,
  );
  return afterKill === "stopped" ? "stopped" : "identity-unproven";
}

async function signalExactProcess(
  receipt: AttemptProcessReceipt,
  signal: NodeJS.Signals,
  observe: NonNullable<ProcessIdentityDependencies["observeProcess"]>,
  dependencies: AttemptCleanupDependencies,
): Promise<boolean> {
  const current = await observe(receipt.pid, receipt.executableRealpath);
  if (!current || current.processStartTime !== receipt.processStartTime) return true;
  if (!managedBrowserProcessMatchesReceipt(current, receipt)) return false;
  try {
    (dependencies.sendSignal ?? process.kill)(receipt.pid, signal);
    return true;
  } catch {
    const afterSignalError = await observe(receipt.pid, receipt.executableRealpath);
    return !afterSignalError || afterSignalError.processStartTime !== receipt.processStartTime;
  }
}

async function waitForOriginalProcessExit(
  receipt: AttemptProcessReceipt,
  observe: NonNullable<ProcessIdentityDependencies["observeProcess"]>,
  wait: ProcessIdentityDependencies["wait"],
  timeoutMs: number,
): Promise<"stopped" | "running" | "identity-unproven"> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await observe(receipt.pid, receipt.executableRealpath);
    if (!current || current.processStartTime !== receipt.processStartTime) return "stopped";
    if (!managedBrowserProcessMatchesReceipt(current, receipt)) return "identity-unproven";
    await (wait ?? delay)(25);
  } while (Date.now() <= deadline);
  return "running";
}

function isAttemptSandboxOwner(value: unknown): value is AttemptSandboxOwner {
  const owner = value as Partial<AttemptSandboxOwner> | undefined;
  return Boolean(
    owner &&
    owner.schemaVersion === "oracle.attempt-sandbox-owner.v1" &&
    owner.jobId &&
    owner.turnAttemptId &&
    ["dispatch", "capture", "probe"].includes(owner.purpose ?? "") &&
    owner.seedGeneration &&
    owner.profileRealpath &&
    owner.createdAt,
  );
}

function isAttemptProcessReceipt(value: unknown): value is AttemptProcessReceipt {
  const receipt = value as Partial<AttemptProcessReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schemaVersion === "oracle.attempt-process.v1" &&
    receipt.jobId &&
    receipt.turnAttemptId &&
    receipt.profileRealpath &&
    receipt.executableRealpath &&
    Number.isSafeInteger(receipt.pid) &&
    (receipt.pid ?? 0) > 0 &&
    receipt.processStartTime &&
    receipt.debugHost === "127.0.0.1" &&
    Number.isSafeInteger(receipt.debugPort) &&
    (receipt.debugPort ?? 0) > 0 &&
    receipt.startedAt,
  );
}

function sameAttemptOwner(left: AttemptSandboxOwner, right: AttemptSandboxOwner): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.turnAttemptId === right.turnAttemptId &&
    left.purpose === right.purpose &&
    left.seedGeneration === right.seedGeneration &&
    left.profileRealpath === right.profileRealpath &&
    left.createdAt === right.createdAt
  );
}

function validateOwnerField(label: string, value: string): void {
  if (!value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Attempt sandbox ${label} is invalid`);
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function copyProfileDirectory(source: string, destination: string): Promise<void> {
  const entries = await readdir(source);
  for (const entry of entries) {
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function writeImmutablePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeExclusivePrivateJson(filePath, value);
  if (process.platform !== "win32") await chmod(filePath, 0o400);
}

async function writeExclusivePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return raw === undefined ? undefined : (JSON.parse(raw) as T);
}

async function releaseAttemptProcessLifecycleReservation(
  reservationPath: string,
  token: string,
): Promise<void> {
  const reservation = await readJson<AttemptProcessLifecycleReservation>(reservationPath);
  if (
    reservation?.schemaVersion !== "oracle.attempt-process-lifecycle.v1" ||
    reservation.token !== token
  ) {
    return;
  }
  const releasedPath = `${reservationPath}.release-${token}`;
  try {
    await rename(reservationPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(releasedPath, { force: true });
}

async function reclaimStaleAttemptProcessLifecycleReservation(
  reservationPath: string,
  expectedOwner: AttemptSandboxOwner,
): Promise<boolean> {
  const reservation = await readJson<AttemptProcessLifecycleReservation>(reservationPath);
  if (reservation === undefined) return true;
  if (!isAttemptProcessLifecycleReservation(reservation)) return false;
  if (
    reservation.jobId !== expectedOwner.jobId ||
    reservation.turnAttemptId !== expectedOwner.turnAttemptId
  ) {
    return false;
  }
  const observedStartTime =
    reservation.pid === process.pid
      ? await getCurrentProcessStartTime()
      : await observeLocalProcessStartTime(reservation.pid);
  if (observedStartTime === reservation.processStartTime) return false;
  const confirmed = await readJson<AttemptProcessLifecycleReservation>(reservationPath);
  if (!isAttemptProcessLifecycleReservation(confirmed) || confirmed.token !== reservation.token) {
    return false;
  }
  const stalePath = `${reservationPath}.stale-${reservation.token}-${randomUUID()}`;
  try {
    await rename(reservationPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(stalePath, { force: true });
  return true;
}

function isAttemptProcessLifecycleReservation(
  value: unknown,
): value is AttemptProcessLifecycleReservation {
  const reservation = value as Partial<AttemptProcessLifecycleReservation> | undefined;
  return Boolean(
    reservation &&
    reservation.schemaVersion === "oracle.attempt-process-lifecycle.v1" &&
    reservation.token &&
    reservation.jobId &&
    reservation.turnAttemptId &&
    Number.isSafeInteger(reservation.pid) &&
    (reservation.pid ?? 0) > 0 &&
    reservation.processStartTime &&
    reservation.createdAt,
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  return lstat(candidate)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const attemptSandboxTestHooks = {
  sameAttemptOwner,
  stopExactAttemptProcess,
};
