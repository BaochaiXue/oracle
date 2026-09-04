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
  rmdir,
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
const QUARANTINE_RECEIPT = "quarantine.json";
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

interface AttemptSandboxQuarantineReceipt {
  schemaVersion: "oracle.attempt-sandbox-quarantine.v1";
  token: string;
  sandboxId: string;
  sourceDirectory: string;
  quarantineDirectory: string;
  owner: AttemptSandboxOwner;
  processStatus: Exclude<AttemptSandboxCleanupReceipt["processStatus"], "identity-unproven">;
  quarantinedAt: string;
}

export interface AttemptCleanupDependencies extends ProcessIdentityDependencies {
  findProcessesUsingProfile?: typeof findManagedBrowserProcessesUsingProfile;
  removeQuarantinedSandbox?: (quarantineDirectory: string) => Promise<void>;
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
      const sandboxId = attemptSandboxId(input);
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
      const quarantine = await prepareAttemptSandboxQuarantine(runtimeRoot, sandbox, processStatus);
      try {
        await withBrowserLockMutation(runtimeRoot, () =>
          rename(directoryRealpath, quarantine.quarantineDirectory),
        );
      } catch (error) {
        return completed("blocked", processStatus, {
          error: `Sandbox quarantine failed before deletion: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      try {
        const removeQuarantinedSandbox = input.dependencies?.removeQuarantinedSandbox;
        await withBrowserLockMutation(runtimeRoot, () =>
          removeQuarantinedSandbox
            ? removeQuarantinedSandbox(quarantine.quarantineDirectory)
            : removeAttemptSandboxQuarantine(quarantine.quarantineDirectory, quarantine),
        );
        return completed("deleted", processStatus);
      } catch (error) {
        return completed("quarantined", processStatus, {
          quarantinePath: quarantine.quarantineDirectory,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } catch (error) {
    return completed("blocked", "identity-unproven", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function prepareAttemptSandboxQuarantine(
  runtimeRoot: string,
  sandbox: AttemptSandbox,
  processStatus: Exclude<AttemptSandboxCleanupReceipt["processStatus"], "identity-unproven">,
): Promise<AttemptSandboxQuarantineReceipt> {
  const receiptPath = path.join(sandbox.directory, QUARANTINE_RECEIPT);
  const existing = await readJson<AttemptSandboxQuarantineReceipt>(receiptPath);
  if (existing) {
    if (!(await matchesPreparedAttemptQuarantine(runtimeRoot, sandbox, existing))) {
      throw new Error("Attempt sandbox quarantine receipt is invalid or belongs elsewhere");
    }
    return existing;
  }
  const quarantineRoot = await resolveAttemptQuarantineRoot(runtimeRoot, true);
  const token = randomUUID();
  const quarantine: AttemptSandboxQuarantineReceipt = {
    schemaVersion: "oracle.attempt-sandbox-quarantine.v1",
    token,
    sandboxId: sandbox.sandboxId,
    sourceDirectory: sandbox.directory,
    quarantineDirectory: path.join(quarantineRoot, `${sandbox.sandboxId}.${token}`),
    owner: sandbox.owner,
    processStatus,
    quarantinedAt: new Date().toISOString(),
  };
  await writeImmutablePrivateJson(receiptPath, quarantine);
  return quarantine;
}

async function matchesPreparedAttemptQuarantine(
  runtimeRoot: string,
  sandbox: AttemptSandbox,
  receipt: AttemptSandboxQuarantineReceipt,
): Promise<boolean> {
  if (!isAttemptSandboxQuarantineReceipt(receipt)) return false;
  const quarantineRoot = await resolveAttemptQuarantineRoot(runtimeRoot, false);
  return (
    receipt.sandboxId === sandbox.sandboxId &&
    attemptSandboxId(receipt.owner) === sandbox.sandboxId &&
    receipt.sourceDirectory === sandbox.directory &&
    receipt.owner.profileRealpath === sandbox.profileDir &&
    path.dirname(receipt.quarantineDirectory) === quarantineRoot &&
    path.basename(receipt.quarantineDirectory) === `${receipt.sandboxId}.${receipt.token}` &&
    sameAttemptOwner(receipt.owner, sandbox.owner)
  );
}

export async function reconcileAttemptSandboxQuarantines(runtimeRoot: string): Promise<void> {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const quarantineRoot = path.join(resolvedRuntimeRoot, QUARANTINE_DIRECTORY);
  if (!(await pathExists(quarantineRoot))) return;
  const runtimeRealpath = await realpath(resolvedRuntimeRoot);
  const quarantineRealpath = await resolveAttemptQuarantineRoot(runtimeRealpath, false);
  await withBrowserLockMutation(runtimeRealpath, async () => {
    for (const entry of await readdir(quarantineRealpath, { withFileTypes: true })) {
      const quarantineDirectory = path.join(quarantineRealpath, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryRealpath = await realpath(quarantineDirectory);
      if (path.dirname(directoryRealpath) !== quarantineRealpath) continue;
      const receipt = await readJson<AttemptSandboxQuarantineReceipt>(
        path.join(directoryRealpath, QUARANTINE_RECEIPT),
      ).catch(() => undefined);
      if (!receipt) {
        if (
          /^[a-f0-9]{64}\.[a-f0-9-]{36}$/iu.test(entry.name) &&
          (await readdir(directoryRealpath)).length === 0
        ) {
          await rmdir(directoryRealpath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
          });
        }
        continue;
      }
      if (!(await matchesMovedAttemptQuarantine(runtimeRealpath, directoryRealpath, receipt))) {
        continue;
      }
      await removeAttemptSandboxQuarantine(directoryRealpath, receipt);
    }
  });
}

async function matchesMovedAttemptQuarantine(
  runtimeRoot: string,
  quarantineDirectory: string,
  receipt: AttemptSandboxQuarantineReceipt,
): Promise<boolean> {
  if (!isAttemptSandboxQuarantineReceipt(receipt)) return false;
  const quarantineRoot = await realpath(path.join(runtimeRoot, QUARANTINE_DIRECTORY));
  const attemptsRoot = await realpath(path.join(runtimeRoot, ATTEMPTS_DIRECTORY));
  const recordedSourceParent = await realpath(path.dirname(receipt.sourceDirectory)).catch(
    () => undefined,
  );
  const recordedQuarantineRealpath = await realpath(receipt.quarantineDirectory).catch(
    () => undefined,
  );
  return (
    path.dirname(quarantineDirectory) === quarantineRoot &&
    recordedQuarantineRealpath === quarantineDirectory &&
    path.basename(quarantineDirectory) === `${receipt.sandboxId}.${receipt.token}` &&
    recordedSourceParent === attemptsRoot &&
    path.basename(receipt.sourceDirectory) === receipt.sandboxId &&
    receipt.owner.profileRealpath === path.join(receipt.sourceDirectory, "profile") &&
    attemptSandboxId(receipt.owner) === receipt.sandboxId
  );
}

async function removeAttemptSandboxQuarantine(
  quarantineDirectory: string,
  expected: AttemptSandboxQuarantineReceipt,
): Promise<void> {
  const receiptPath = path.join(quarantineDirectory, QUARANTINE_RECEIPT);
  for (const name of await readdir(quarantineDirectory)) {
    if (name === QUARANTINE_RECEIPT) continue;
    await rm(path.join(quarantineDirectory, name), { recursive: true, force: true });
  }
  const confirmed = await readJson<AttemptSandboxQuarantineReceipt>(receiptPath);
  if (!confirmed || !sameAttemptQuarantineReceipt(confirmed, expected)) {
    throw new Error("Attempt sandbox quarantine ownership changed during cleanup");
  }
  await rm(receiptPath, { force: false });
  await rmdir(quarantineDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function listAttemptQuarantineEntries(runtimeRoot: string): Promise<string[]> {
  const quarantineRoot = path.join(path.resolve(runtimeRoot), QUARANTINE_DIRECTORY);
  if (!(await pathExists(quarantineRoot))) return [];
  const quarantineRealpath = await resolveAttemptQuarantineRoot(runtimeRoot, false);
  const entries = await readdir(quarantineRealpath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.map((entry) => path.join(quarantineRealpath, entry)).sort();
}

async function resolveAttemptQuarantineRoot(runtimeRoot: string, create: boolean): Promise<string> {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  if (create) await ensurePrivateDirectory(resolvedRuntimeRoot);
  const runtimeRealpath = await realpath(resolvedRuntimeRoot);
  const quarantineRoot = path.join(runtimeRealpath, QUARANTINE_DIRECTORY);
  if (create) await ensurePrivateDirectory(quarantineRoot);
  const entry = await lstat(quarantineRoot);
  const quarantineRealpath = await realpath(quarantineRoot);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    path.dirname(quarantineRealpath) !== runtimeRealpath
  ) {
    throw new Error("Attempt quarantine root is not one exact directory under the runtime root");
  }
  return quarantineRealpath;
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

function attemptSandboxId(
  owner: Pick<AttemptSandboxOwner, "jobId" | "turnAttemptId" | "purpose">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "oracle.attempt-sandbox-owner.v1",
        owner.jobId,
        owner.turnAttemptId,
        owner.purpose,
      ]),
    )
    .digest("hex");
}

function isAttemptSandboxQuarantineReceipt(
  value: unknown,
): value is AttemptSandboxQuarantineReceipt {
  const receipt = value as Partial<AttemptSandboxQuarantineReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schemaVersion === "oracle.attempt-sandbox-quarantine.v1" &&
    typeof receipt.token === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(receipt.token) &&
    typeof receipt.sandboxId === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.sandboxId) &&
    typeof receipt.sourceDirectory === "string" &&
    path.isAbsolute(receipt.sourceDirectory) &&
    typeof receipt.quarantineDirectory === "string" &&
    path.isAbsolute(receipt.quarantineDirectory) &&
    isAttemptSandboxOwner(receipt.owner) &&
    ["none", "already-stopped", "stopped"].includes(receipt.processStatus ?? "") &&
    typeof receipt.quarantinedAt === "string" &&
    receipt.quarantinedAt.length > 0,
  );
}

function sameAttemptQuarantineReceipt(
  left: AttemptSandboxQuarantineReceipt,
  right: AttemptSandboxQuarantineReceipt,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.token === right.token &&
    left.sandboxId === right.sandboxId &&
    left.sourceDirectory === right.sourceDirectory &&
    left.quarantineDirectory === right.quarantineDirectory &&
    sameAttemptOwner(left.owner, right.owner) &&
    left.processStatus === right.processStatus &&
    left.quarantinedAt === right.quarantinedAt
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
