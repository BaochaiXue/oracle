import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  link,
  mkdir,
  opendir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ORACLE_BROWSER_RUNTIME_ID } from "./types.js";
import type {
  AuthSeedCandidateReceipt,
  AuthSeedCertificationReceipt,
  AuthSeedCloneProofReceipt,
  AuthSeedReceipt,
} from "./types.js";

const AUTH_SEED_DIRECTORY = "auth-seed";
const CANDIDATES_DIRECTORY = "auth-seed-candidates";
const ATTEMPTS_DIRECTORY = "attempts";
const RUN_DIRECTORY = "run";
const LOCK_DIRECTORY = "auth-seed.lock";
const LOCK_POLL_MS = 25;
const execFileAsync = promisify(execFile);
let currentProcessStartTime: Promise<string> | undefined;

interface AuthSeedLockOwner {
  schemaVersion: "oracle.auth-seed-lock-owner.v2";
  token: string;
  pid: number;
  processStartTime: string;
  mode: "shared" | "exclusive";
  createdAt: string;
}

type AuthSeedLockOwnerObservation =
  | { status: "valid"; owner: AuthSeedLockOwner }
  | { status: "missing" | "invalid" };

export type AuthSeedCloneSource =
  | Pick<AuthSeedCandidateReceipt, "candidateId" | "profileRealpath" | "profileDigest">
  | Pick<AuthSeedReceipt, "generation" | "profileRealpath" | "profileDigest">;

export interface AuthSeedPaths {
  root: string;
  profile: string;
  seedReceipt: string;
  certification: string;
}

export function authSeedPaths(runtimeRoot: string): AuthSeedPaths {
  const root = path.join(path.resolve(runtimeRoot), AUTH_SEED_DIRECTORY);
  return {
    root,
    profile: path.join(root, "profile"),
    seedReceipt: path.join(root, "seed.json"),
    certification: path.join(root, "certification.json"),
  };
}

export async function createAuthSeedCandidate(input: {
  runtimeRoot: string;
  sourceProfileDir: string;
  copyProfile?: (source: string, destination: string) => Promise<void>;
  lockTimeoutMs?: number;
}): Promise<AuthSeedCandidateReceipt> {
  return withAuthSeedRefreshLock(
    input.runtimeRoot,
    async () => {
      const runtimeRoot = path.resolve(input.runtimeRoot);
      const migrationProfile = path.join(runtimeRoot, "browser-profile");
      const sourceProfileRealpath = await realpath(input.sourceProfileDir);
      const migrationProfileRealpath = await realpath(migrationProfile);
      if (
        path.resolve(input.sourceProfileDir) !== migrationProfile ||
        sourceProfileRealpath !== migrationProfileRealpath
      ) {
        throw new Error(
          "Auth-seed candidates may be created only from the exact fixed migration profile",
        );
      }
      if (!(await stat(sourceProfileRealpath)).isDirectory()) {
        throw new Error("Auth-seed source profile is not a directory");
      }
      await ensurePrivateDirectory(runtimeRoot);
      const candidatesRoot = path.join(runtimeRoot, CANDIDATES_DIRECTORY);
      await ensurePrivateDirectory(candidatesRoot);
      const candidatesRealpath = await realpath(candidatesRoot);
      const candidateId = randomUUID();
      const finalRoot = path.join(candidatesRealpath, candidateId);
      const finalProfile = path.join(finalRoot, "profile");
      const stagingRoot = path.join(candidatesRealpath, `.${candidateId}.${randomUUID()}.tmp`);
      const stagingProfile = path.join(stagingRoot, "profile");
      await ensurePrivateDirectory(stagingRoot);
      let published = false;
      try {
        await (input.copyProfile ?? copyProfileDirectory)(sourceProfileRealpath, stagingProfile);
        await chmod(stagingProfile, 0o700);
        const profileDigest = await digestProfile(stagingProfile);
        const receipt: AuthSeedCandidateReceipt = {
          schemaVersion: "oracle.auth-seed-candidate.v1",
          candidateId,
          sourceProfileRealpath,
          profileRealpath: finalProfile,
          profileDigest,
          createdAt: new Date().toISOString(),
        };
        await writeImmutablePrivateJson(path.join(stagingRoot, "candidate.json"), receipt);
        await rename(stagingRoot, finalRoot);
        published = true;
        if ((await realpath(finalProfile)) !== finalProfile) {
          throw new Error("Auth-seed candidate profile did not resolve to its recorded path");
        }
        return receipt;
      } catch (error) {
        await rm(published ? finalRoot : stagingRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    },
    { timeoutMs: input.lockTimeoutMs },
  );
}

export async function readAuthSeedCandidate(
  candidateRoot: string,
): Promise<AuthSeedCandidateReceipt> {
  const receipt = await readJson<AuthSeedCandidateReceipt>(
    path.join(path.resolve(candidateRoot), "candidate.json"),
  );
  if (!isAuthSeedCandidateReceipt(receipt)) {
    throw new Error("Auth-seed candidate receipt is missing or invalid");
  }
  const profileRealpath = await realpath(path.join(path.resolve(candidateRoot), "profile"));
  if (profileRealpath !== receipt.profileRealpath) {
    throw new Error("Auth-seed candidate profile path does not match its receipt");
  }
  return receipt;
}

export async function discardAuthSeedCandidate(input: {
  runtimeRoot: string;
  candidateRoot: string;
  expectedCandidateId: string;
  lockTimeoutMs?: number;
}): Promise<"deleted" | "already-absent"> {
  return withAuthSeedRefreshLock(
    input.runtimeRoot,
    async () => {
      const candidateRoot = path.resolve(input.candidateRoot);
      if (!(await pathExists(candidateRoot))) return "already-absent";
      const candidate = await readAuthSeedCandidate(candidateRoot);
      await validateCandidateLocation(input.runtimeRoot, candidateRoot, candidate);
      if (
        candidate.candidateId !== input.expectedCandidateId ||
        path.basename(candidateRoot) !== candidate.candidateId
      ) {
        throw new Error("Refusing to discard an unproven auth-seed candidate");
      }
      await rm(candidateRoot, { recursive: true, force: false });
      return "deleted";
    },
    { timeoutMs: input.lockTimeoutMs },
  );
}

export async function acceptAuthSeedCandidate(input: {
  runtimeRoot: string;
  candidateRoot: string;
  cloneProof: AuthSeedCloneProofReceipt;
  lockTimeoutMs?: number;
}): Promise<AuthSeedCertificationReceipt> {
  return withAuthSeedRefreshLock(
    input.runtimeRoot,
    async () => {
      const runtimeRoot = path.resolve(input.runtimeRoot);
      const candidateRoot = path.resolve(input.candidateRoot);
      const candidate = await readAuthSeedCandidate(candidateRoot);
      await validateCandidateLocation(runtimeRoot, candidateRoot, candidate);
      validateCloneProof(candidate, input.cloneProof);
      if ((await digestProfile(candidate.profileRealpath)) !== candidate.profileDigest) {
        throw new Error("Auth-seed candidate changed during clone isolation proof");
      }
      if ((await countAttemptEntries(runtimeRoot)) !== 0) {
        throw new Error("Auth-seed candidate cannot be accepted while attempt sandboxes remain");
      }
      const paths = authSeedPaths(runtimeRoot);
      if (await pathExists(paths.root)) {
        throw new Error(
          "An accepted auth seed already exists; refresh requires a later owner gate",
        );
      }
      const runtimeRealpath = await realpath(runtimeRoot);
      const finalRoot = path.join(runtimeRealpath, AUTH_SEED_DIRECTORY);
      const finalProfile = path.join(finalRoot, "profile");
      const acceptedAt = new Date().toISOString();
      const generation = randomUUID();
      const seed: AuthSeedReceipt = {
        schemaVersion: "oracle.auth-seed.v1",
        generation,
        profileRealpath: finalProfile,
        profileDigest: candidate.profileDigest,
        acceptedAt,
      };
      const certification: AuthSeedCertificationReceipt = {
        schemaVersion: "oracle.auth-seed-certification.v1",
        runtimeId: ORACLE_BROWSER_RUNTIME_ID,
        browserRuntimeId: input.cloneProof.browserRuntimeId,
        transport: "direct-cdp",
        seedGeneration: generation,
        profileRealpath: finalProfile,
        profileDigest: candidate.profileDigest,
        executableRealpath: input.cloneProof.executableRealpath,
        cloneProof: input.cloneProof,
        certifiedAt: acceptedAt,
      };
      const seedReceiptPath = path.join(candidateRoot, "seed.json");
      const certificationPath = path.join(candidateRoot, "certification.json");
      await rm(seedReceiptPath, { force: true });
      await rm(certificationPath, { force: true });
      try {
        await writeImmutablePrivateJson(seedReceiptPath, seed);
        await writeImmutablePrivateJson(certificationPath, certification);
        await rename(candidateRoot, finalRoot);
      } catch (error) {
        await rm(seedReceiptPath, { force: true }).catch(() => undefined);
        await rm(certificationPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await rm(path.join(finalRoot, "candidate.json"), { force: true });
      if ((await realpath(paths.profile)) !== finalProfile) {
        throw new Error("Accepted auth-seed profile did not resolve to its recorded path");
      }
      return certification;
    },
    { timeoutMs: input.lockTimeoutMs },
  );
}

export async function readAuthSeed(runtimeRoot: string): Promise<AuthSeedReceipt | undefined> {
  const paths = authSeedPaths(runtimeRoot);
  const receipt = await readJson<AuthSeedReceipt>(paths.seedReceipt);
  if (receipt === undefined) return undefined;
  if (!isAuthSeedReceipt(receipt)) throw new Error("Auth-seed receipt is invalid");
  const profileRealpath = await realpath(paths.profile);
  if (profileRealpath !== receipt.profileRealpath) {
    throw new Error("Auth-seed profile path does not match its receipt");
  }
  return receipt;
}

export async function readAuthSeedCertification(
  runtimeRoot: string,
): Promise<AuthSeedCertificationReceipt | undefined> {
  const receipt = await readJson<AuthSeedCertificationReceipt>(
    authSeedPaths(runtimeRoot).certification,
  );
  if (receipt === undefined) return undefined;
  if (
    receipt.schemaVersion !== "oracle.auth-seed-certification.v1" ||
    receipt.runtimeId !== ORACLE_BROWSER_RUNTIME_ID ||
    receipt.transport !== "direct-cdp" ||
    !receipt.seedGeneration ||
    !receipt.profileRealpath ||
    !receipt.profileDigest ||
    !receipt.executableRealpath
  ) {
    throw new Error("Auth-seed certification receipt is invalid");
  }
  const seed = await readAuthSeed(runtimeRoot);
  if (
    !seed ||
    seed.generation !== receipt.seedGeneration ||
    seed.profileRealpath !== receipt.profileRealpath ||
    seed.profileDigest !== receipt.profileDigest
  ) {
    throw new Error("Auth-seed certification does not match the accepted seed receipt");
  }
  return receipt;
}

export async function validateAuthSeedCloneSource(
  runtimeRoot: string,
  source: AuthSeedCloneSource,
): Promise<AuthSeedCloneSource> {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const sourceProfileRealpath = await realpath(source.profileRealpath);
  if (sourceProfileRealpath !== source.profileRealpath) {
    throw new Error("Auth-seed clone source must use its exact profile realpath");
  }

  const accepted = await readAuthSeed(resolvedRuntimeRoot);
  if (accepted && sourceProfileRealpath === accepted.profileRealpath) {
    if (!sameCloneSource(accepted, source)) {
      throw new Error("Auth-seed clone source does not match the accepted seed receipt");
    }
    if ((await digestProfile(accepted.profileRealpath)) !== accepted.profileDigest) {
      throw new Error("Accepted auth seed changed after certification");
    }
    return accepted;
  }

  const candidatesRoot = await realpath(path.join(resolvedRuntimeRoot, CANDIDATES_DIRECTORY)).catch(
    () => path.join(resolvedRuntimeRoot, CANDIDATES_DIRECTORY),
  );
  const candidateRoot = path.dirname(sourceProfileRealpath);
  const relativeCandidate = path.relative(candidatesRoot, candidateRoot);
  if (
    !relativeCandidate ||
    relativeCandidate.startsWith("..") ||
    path.isAbsolute(relativeCandidate) ||
    relativeCandidate.includes(path.sep) ||
    path.basename(sourceProfileRealpath) !== "profile"
  ) {
    throw new Error("Auth-seed clone source is neither an accepted seed nor one exact candidate");
  }
  const candidate = await readAuthSeedCandidate(candidateRoot);
  if (!sameCloneSource(candidate, source)) {
    throw new Error("Auth-seed clone source does not match its candidate receipt");
  }
  if ((await digestProfile(candidate.profileRealpath)) !== candidate.profileDigest) {
    throw new Error("Auth-seed candidate changed before cloning");
  }
  return candidate;
}

export async function digestProfile(profileDir: string): Promise<string> {
  const root = await realpath(profileDir);
  const hash = createHash("sha256");
  await digestEntry(root, "", hash);
  return hash.digest("hex");
}

export async function withAuthSeedCloneLock<T>(
  runtimeRoot: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const release = await acquireSeedLock(runtimeRoot, "shared", options.timeoutMs ?? 10_000);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function withAuthSeedRefreshLock<T>(
  runtimeRoot: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const release = await acquireSeedLock(runtimeRoot, "exclusive", options.timeoutMs ?? 10_000);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireSeedLock(
  runtimeRoot: string,
  mode: "shared" | "exclusive",
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const lockRoot = path.join(path.resolve(runtimeRoot), RUN_DIRECTORY, LOCK_DIRECTORY);
  const readersRoot = path.join(lockRoot, "readers");
  const stagingRoot = path.join(lockRoot, "staging");
  const exclusivePath = path.join(lockRoot, "exclusive");
  await ensurePrivateDirectory(readersRoot);
  await ensurePrivateDirectory(stagingRoot);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (mode === "shared") {
      if (await pathExists(exclusivePath)) {
        await reclaimDeadSeedLock(exclusivePath);
      }
      if (await pathExists(exclusivePath)) {
        await delay(LOCK_POLL_MS);
        continue;
      }
      const token = randomUUID();
      const readerPath = path.join(readersRoot, token);
      const release = await publishSeedLock(readerPath, stagingRoot, mode, token);
      if (!(await pathExists(exclusivePath))) {
        return release;
      }
      await release();
    } else {
      if (await pathExists(exclusivePath)) {
        await reclaimDeadSeedLock(exclusivePath);
      }
      const token = randomUUID();
      let release: (() => Promise<void>) | undefined;
      try {
        release = await publishSeedLock(exclusivePath, stagingRoot, mode, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(LOCK_POLL_MS);
        continue;
      }
      await reclaimDeadReaderLocks(readersRoot);
      if ((await readdir(readersRoot)).length === 0) {
        return release;
      }
      await release();
    }
    await delay(LOCK_POLL_MS);
  }
  throw new Error(`Timed out acquiring ${mode} auth-seed lock`);
}

async function publishSeedLock(
  lockPath: string,
  stagingRoot: string,
  mode: AuthSeedLockOwner["mode"],
  token: string,
): Promise<() => Promise<void>> {
  currentProcessStartTime ??= requireProcessStartTime(process.pid);
  const owner: AuthSeedLockOwner = {
    schemaVersion: "oracle.auth-seed-lock-owner.v2",
    token,
    pid: process.pid,
    processStartTime: await currentProcessStartTime,
    mode,
    createdAt: new Date().toISOString(),
  };
  const temporary = path.join(stagingRoot, `${token}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await link(temporary, lockPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return async () => releaseSeedLock(lockPath, token);
}

async function releaseSeedLock(lockPath: string, token: string): Promise<void> {
  const observation = await readSeedLockOwner(lockPath);
  if (observation.status !== "valid" || observation.owner.token !== token) return;
  const quarantine = `${lockPath}.release-${token}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(quarantine, { force: true });
}

async function reclaimDeadReaderLocks(readersRoot: string): Promise<void> {
  for (const name of await readdir(readersRoot)) {
    await reclaimDeadSeedLock(path.join(readersRoot, name));
  }
}

async function reclaimDeadSeedLock(lockPath: string): Promise<boolean> {
  const observation = await readSeedLockOwner(lockPath);
  if (observation.status === "valid") {
    const observedStartTime = await observeProcessStartTime(observation.owner.pid);
    if (observedStartTime === observation.owner.processStartTime) return false;
  } else if (observation.status === "invalid") {
    return false;
  } else {
    return true;
  }
  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantine, { force: true });
  return true;
}

async function readSeedLockOwner(lockPath: string): Promise<AuthSeedLockOwnerObservation> {
  const raw = await readFile(lockPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return { status: "missing" };
  let owner: AuthSeedLockOwner;
  try {
    owner = JSON.parse(raw) as AuthSeedLockOwner;
  } catch {
    return { status: "invalid" };
  }
  if (
    owner.schemaVersion !== "oracle.auth-seed-lock-owner.v2" ||
    !owner.token ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !owner.processStartTime ||
    !["shared", "exclusive"].includes(owner.mode) ||
    !owner.createdAt
  ) {
    return { status: "invalid" };
  }
  return { status: "valid", owner };
}

async function requireProcessStartTime(pid: number): Promise<string> {
  const processStartTime = await observeProcessStartTime(pid);
  if (!processStartTime) {
    throw new Error(`Auth-seed lock owner process ${pid} exited before lock publication`);
  }
  return processStartTime;
}

async function observeProcessStartTime(pid: number): Promise<string | undefined> {
  if (!isProcessAlive(pid)) return undefined;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('O') }`,
            ],
            { maxBuffer: 64 * 1024 },
          )
        : await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
            maxBuffer: 64 * 1024,
          });
    const value = String(stdout ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    if (value) return `${process.platform}:${value}`;
    if (!isProcessAlive(pid)) return undefined;
    throw new Error("process inspection returned no start time");
  } catch (error) {
    if (!isProcessAlive(pid)) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Auth-seed lock process inspection failed: ${detail}`, { cause: error });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return code === "EPERM";
  }
}

async function copyProfileDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function digestEntry(
  root: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const absolutePath = relativePath ? path.join(root, relativePath) : root;
  const entry = await lstat(absolutePath);
  if (entry.isDirectory()) {
    hash.update(`d\0${relativePath}\0${entry.mode & 0o777}\0`);
    const directory = await opendir(absolutePath);
    const names: string[] = [];
    for await (const child of directory) names.push(child.name);
    for (const name of names.sort()) {
      await digestEntry(root, relativePath ? path.join(relativePath, name) : name, hash);
    }
    return;
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`Auth-seed profile contains unsupported symlink ${relativePath}`);
  }
  if (!entry.isFile()) {
    throw new Error(`Auth-seed profile contains unsupported entry ${relativePath}`);
  }
  hash.update(`f\0${relativePath}\0${entry.mode & 0o777}\0${entry.size}\0`);
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
  hash.update("\0");
}

function validateCloneProof(
  candidate: AuthSeedCandidateReceipt,
  proof: AuthSeedCloneProofReceipt,
): void {
  if (
    proof.schemaVersion !== "oracle.auth-seed-clone-proof.v1" ||
    proof.candidateId !== candidate.candidateId ||
    proof.seedProfileDigestBefore !== candidate.profileDigest ||
    proof.seedProfileDigestAfter !== candidate.profileDigest ||
    proof.sendEventCount !== 0 ||
    proof.remainingAttemptCount !== 0 ||
    !proof.browserRuntimeId ||
    !proof.executableRealpath ||
    !proof.cloneA.authenticated ||
    !proof.cloneA.modelVerified ||
    !proof.cloneA.effortVerified ||
    !proof.cloneA.initiallyClean ||
    !proof.cloneA.dirtyStateObserved ||
    proof.cloneA.inheritedStateObserved ||
    proof.cloneA.promptSubmitted !== false ||
    proof.cloneACleanup.schemaVersion !== "oracle.attempt-sandbox-cleanup.v1" ||
    proof.cloneACleanup.sandboxId !== proof.cloneA.sandboxId ||
    proof.cloneACleanup.status !== "deleted" ||
    !["already-stopped", "stopped"].includes(proof.cloneACleanup.processStatus) ||
    !proof.cloneB.authenticated ||
    !proof.cloneB.modelVerified ||
    !proof.cloneB.effortVerified ||
    !proof.cloneB.initiallyClean ||
    proof.cloneB.dirtyStateObserved ||
    proof.cloneB.inheritedStateObserved ||
    proof.cloneB.promptSubmitted !== false ||
    proof.cloneBCleanup.schemaVersion !== "oracle.attempt-sandbox-cleanup.v1" ||
    proof.cloneBCleanup.sandboxId !== proof.cloneB.sandboxId ||
    proof.cloneBCleanup.status !== "deleted" ||
    !["already-stopped", "stopped"].includes(proof.cloneBCleanup.processStatus) ||
    proof.cloneA.sandboxId === proof.cloneB.sandboxId
  ) {
    throw new Error("Two-clone no-Send proof does not satisfy auth-seed acceptance");
  }
}

function isAuthSeedCandidateReceipt(value: unknown): value is AuthSeedCandidateReceipt {
  const receipt = value as Partial<AuthSeedCandidateReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schemaVersion === "oracle.auth-seed-candidate.v1" &&
    receipt.candidateId &&
    receipt.sourceProfileRealpath &&
    receipt.profileRealpath &&
    receipt.profileDigest &&
    receipt.createdAt,
  );
}

function isAuthSeedReceipt(value: unknown): value is AuthSeedReceipt {
  const receipt = value as Partial<AuthSeedReceipt> | undefined;
  return Boolean(
    receipt &&
    receipt.schemaVersion === "oracle.auth-seed.v1" &&
    receipt.generation &&
    receipt.profileRealpath &&
    receipt.profileDigest &&
    receipt.acceptedAt,
  );
}

async function validateCandidateLocation(
  runtimeRoot: string,
  candidateRoot: string,
  candidate: AuthSeedCandidateReceipt,
): Promise<void> {
  const candidateRealpath = await realpath(candidateRoot);
  const candidatesRoot = await realpath(path.join(path.resolve(runtimeRoot), CANDIDATES_DIRECTORY));
  if (
    candidateRealpath !== candidateRoot ||
    path.dirname(candidateRealpath) !== candidatesRoot ||
    path.basename(candidateRealpath) !== candidate.candidateId
  ) {
    throw new Error("Auth-seed candidate is not one exact receipted child of its runtime root");
  }
}

async function countAttemptEntries(runtimeRoot: string): Promise<number> {
  const attemptsRoot = path.join(runtimeRoot, ATTEMPTS_DIRECTORY);
  const entries = await readdir(attemptsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.length;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function writeImmutablePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o400);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sameCloneSource(left: AuthSeedCloneSource, right: AuthSeedCloneSource): boolean {
  return (
    cloneSourceIdentity(left) === cloneSourceIdentity(right) &&
    left.profileRealpath === right.profileRealpath &&
    left.profileDigest === right.profileDigest
  );
}

export function authSeedCloneSourceGeneration(source: AuthSeedCloneSource): string {
  return "generation" in source ? source.generation : source.candidateId;
}

function cloneSourceIdentity(source: AuthSeedCloneSource): string {
  return "generation" in source ? `seed:${source.generation}` : `candidate:${source.candidateId}`;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return raw === undefined ? undefined : (JSON.parse(raw) as T);
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
