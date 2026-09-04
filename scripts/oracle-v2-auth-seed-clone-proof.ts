#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { OracleClient } from "../packages/oracle-client/src/index.js";
import {
  dirtyAttemptSandboxWithoutSend,
  monitorPotentialSubmissions,
  observeAttemptSandboxPage,
  observeStableAttemptSandboxPage,
  probeCompatibility,
  probeModelAndEffortControls,
} from "../packages/chatgpt-adapter/src/index.js";
import {
  acceptAuthSeedCandidate,
  cleanupAttemptSandbox,
  createAttemptSandbox,
  createAuthSeedCandidate,
  digestProfile,
  discardAuthSeedCandidate,
  findManagedBrowserProcessesUsingProfile,
  launchAttemptBrowserRuntime,
  listAttemptQuarantineEntries,
  listAttemptSandboxDirectories,
  readAuthSeed,
  reconcileAttemptSandboxQuarantines,
  type AttemptSandboxCleanupReceipt,
  type AuthSeedCandidateReceipt,
  type AuthSeedCloneProofReceipt,
  type CloneIsolationObservation,
  type OracleAttemptBrowserRuntime,
} from "../packages/oracle-browser-runtime/src/index.js";

const CHATGPT_URL = "https://chatgpt.com/";
const PROBE_FILENAME = "oracle-v2-no-send-clone-proof.md";
const PROBE_TIMEOUT_MS = 30_000;
const runtimeRoot = path.resolve(
  process.env.ORACLE_V2_RUNTIME_ROOT?.trim() || path.join(homedir(), ".oracle", "v2"),
);

interface CloneRunResult {
  observation: CloneIsolationObservation;
  cleanup: AttemptSandboxCleanupReceipt;
  browserRuntimeId: string;
  executableRealpath: string;
  sendEventCount: number;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      "The owner-authorized T1 clone proof currently requires the macOS GUI worker host",
    );
  }
  const sourceProfile = path.join(runtimeRoot, "browser-profile");
  await assertWorkerStopped();
  await assertProfileUnused(sourceProfile, "fixed v2 source profile");
  if (await readAuthSeed(runtimeRoot)) {
    throw new Error("An accepted auth seed already exists; this T1 command never replaces it");
  }
  await reconcileAttemptSandboxQuarantines(runtimeRoot);
  if ((await countAttemptResidue()).total > 0) {
    throw new Error(
      "T1 clone proof refuses to run while an earlier attempt sandbox or quarantine residue remains",
    );
  }

  let candidate: AuthSeedCandidateReceipt | undefined;
  let accepted = false;
  try {
    candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: sourceProfile,
    });
    const marker = `oracle-v2-no-send-${randomUUID()}`;
    const cloneA = await runClone(candidate, "a", marker, true);
    const cloneB = await runClone(candidate, "b", marker, false);
    const seedProfileDigestAfter = await digestProfile(candidate.profileRealpath);
    const remainingAttemptCount = (await countAttemptResidue()).total;
    await assertProfileUnused(candidate.profileRealpath, "auth-seed candidate");
    const sendEventCount = cloneA.sendEventCount + cloneB.sendEventCount;
    const proof: AuthSeedCloneProofReceipt = {
      schemaVersion: "oracle.auth-seed-clone-proof.v1",
      candidateId: candidate.candidateId,
      seedProfileDigestBefore: candidate.profileDigest,
      seedProfileDigestAfter,
      browserRuntimeId: cloneB.browserRuntimeId,
      executableRealpath: cloneB.executableRealpath,
      cloneA: cloneA.observation,
      cloneACleanup: cloneA.cleanup,
      cloneB: cloneB.observation,
      cloneBCleanup: cloneB.cleanup,
      sendEventCount: expectZero(sendEventCount, "potential submission events"),
      remainingAttemptCount: expectZero(
        remainingAttemptCount,
        "remaining attempt sandbox or quarantine entries",
      ),
      completedAt: new Date().toISOString(),
    };
    if (
      cloneA.browserRuntimeId !== cloneB.browserRuntimeId ||
      cloneA.executableRealpath !== cloneB.executableRealpath
    ) {
      throw new Error("Clone A and clone B did not use the same exact managed browser runtime");
    }
    const certification = await acceptAuthSeedCandidate({
      runtimeRoot,
      candidateRoot: path.dirname(candidate.profileRealpath),
      cloneProof: proof,
    });
    accepted = true;
    print({
      schemaVersion: "oracle.auth-seed-clone-proof-summary.v1",
      status: "certified",
      seedGeneration: certification.seedGeneration,
      cloneA: {
        authenticated: proof.cloneA.authenticated,
        modelVerified: proof.cloneA.modelVerified,
        effortVerified: proof.cloneA.effortVerified,
        initiallyClean: proof.cloneA.initiallyClean,
        dirtyStateObserved: proof.cloneA.dirtyStateObserved,
        promptSubmitted: false,
        cleanup: proof.cloneACleanup.status,
      },
      cloneB: {
        authenticated: proof.cloneB.authenticated,
        modelVerified: proof.cloneB.modelVerified,
        effortVerified: proof.cloneB.effortVerified,
        initiallyClean: proof.cloneB.initiallyClean,
        inheritedStateObserved: proof.cloneB.inheritedStateObserved,
        promptSubmitted: false,
        cleanup: proof.cloneBCleanup.status,
      },
      sendEventCount: proof.sendEventCount,
      remainingAttemptCount: proof.remainingAttemptCount,
      seedUnchanged: proof.seedProfileDigestBefore === proof.seedProfileDigestAfter,
    });
  } finally {
    if (candidate && !accepted) {
      await discardAuthSeedCandidate({
        runtimeRoot,
        candidateRoot: path.dirname(candidate.profileRealpath),
        expectedCandidateId: candidate.candidateId,
      });
    }
  }
}

async function countAttemptResidue(): Promise<{
  attempts: number;
  quarantines: number;
  total: number;
}> {
  const [attempts, quarantines] = await Promise.all([
    listAttemptSandboxDirectories(runtimeRoot),
    listAttemptQuarantineEntries(runtimeRoot),
  ]);
  return {
    attempts: attempts.length,
    quarantines: quarantines.length,
    total: attempts.length + quarantines.length,
  };
}

async function runClone(
  candidate: AuthSeedCandidateReceipt,
  suffix: "a" | "b",
  marker: string,
  dirty: boolean,
): Promise<CloneRunResult> {
  const sandbox = await createAttemptSandbox({
    runtimeRoot,
    seed: candidate,
    jobId: `t1-clone-proof-${suffix}`,
    turnAttemptId: randomUUID(),
    purpose: "probe",
  });
  let runtime: OracleAttemptBrowserRuntime | undefined;
  let monitor: ReturnType<typeof monitorPotentialSubmissions> | undefined;
  let observation: CloneIsolationObservation | undefined;
  let browserRuntimeId = "";
  let executableRealpath = "";
  let operationError: unknown;
  try {
    runtime = await launchAttemptBrowserRuntime({
      sandboxDirectory: sandbox.directory,
      headless: false,
    });
    browserRuntimeId = runtime.receipt.browserRuntimeId;
    executableRealpath = runtime.processReceipt.executableRealpath;
    const page = await runtime.openPage(CHATGPT_URL);
    monitor = monitorPotentialSubmissions(page);
    const initial = await observeStableAttemptSandboxPage(page, {
      marker,
      filename: PROBE_FILENAME,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const initiallyClean =
      initial.composerPresent &&
      initial.composerEmpty &&
      !initial.markerPresent &&
      !initial.attachmentPresent &&
      !initial.attachmentInputSelected &&
      !initial.recoveryWindowNamePresent &&
      !initial.recoveryStoragePresent &&
      !initial.userTurnPresent &&
      !initial.conversationRoutePresent &&
      runtime.receipt.restoredPageCount === 0;
    if (!initiallyClean) {
      throw new Error(
        `Clone ${suffix.toUpperCase()} did not start clean; its whole sandbox will be discarded without editing the inherited state`,
      );
    }
    const compatibility = await probeCompatibility(page, {
      adapterVersion: "chatgpt-adapter-v2-t1-clone-proof",
      browserRuntimeId,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const model = await probeModelAndEffortControls(page, { timeoutMs: PROBE_TIMEOUT_MS });
    let dirtyStateObserved = false;
    if (dirty) {
      await dirtyAttemptSandboxWithoutSend(page, {
        marker,
        filename: PROBE_FILENAME,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      await page.evaluate(() => {
        window.name = "oracle-v2-recovery-t1-clone-proof";
        localStorage.setItem("oracle-v2-recovery-t1-clone-proof", "present");
      });
      const dirtyObservation = await observeAttemptSandboxPage(page, {
        marker,
        filename: PROBE_FILENAME,
      });
      dirtyStateObserved =
        dirtyObservation.markerPresent &&
        dirtyObservation.attachmentPresent &&
        dirtyObservation.recoveryWindowNamePresent &&
        dirtyObservation.recoveryStoragePresent;
    }
    await page.waitForTimeout(500);
    if (monitor.count() !== 0) {
      throw new Error(`Clone ${suffix.toUpperCase()} observed a potential submission event`);
    }
    if (runtime.receipt.restoredPageCount !== 0) {
      throw new Error(
        `Clone ${suffix.toUpperCase()} received a restored page after startup reconciliation`,
      );
    }
    const inheritedStateObserved = !initiallyClean;
    observation = {
      sandboxId: sandbox.sandboxId,
      authenticated: compatibility.capabilities.loginState === "verified",
      modelVerified: model.modelVerified,
      effortVerified: model.effortVerified,
      initiallyClean,
      dirtyStateObserved,
      inheritedStateObserved,
      promptSubmitted: false,
    };
    assertCloneObservation(observation, dirty);
  } catch (error) {
    operationError = error;
  } finally {
    monitor?.stop();
    await runtime?.close().catch((error) => {
      operationError ??= error;
    });
    if (runtime && runtime.receipt.restoredPageCount !== 0) {
      operationError ??= new Error(
        `Clone ${suffix.toUpperCase()} received a restored page after startup reconciliation`,
      );
    }
  }
  const cleanup = await cleanupAttemptSandbox({
    runtimeRoot,
    sandboxDirectory: sandbox.directory,
    expectedOwner: sandbox.owner,
  });
  if (cleanup.status !== "deleted" || cleanup.processStatus === "identity-unproven") {
    throw new Error(`Clone ${suffix.toUpperCase()} cleanup was not proven: ${cleanup.status}`);
  }
  if (operationError) throw operationError;
  if (!observation || !browserRuntimeId || !executableRealpath) {
    throw new Error(`Clone ${suffix.toUpperCase()} did not produce a complete proof receipt`);
  }
  return {
    observation,
    cleanup,
    browserRuntimeId,
    executableRealpath,
    sendEventCount: monitor?.count() ?? 0,
  };
}

function assertCloneObservation(
  observation: CloneIsolationObservation,
  shouldBeDirty: boolean,
): void {
  if (
    !observation.authenticated ||
    !observation.modelVerified ||
    !observation.effortVerified ||
    !observation.initiallyClean ||
    observation.inheritedStateObserved ||
    observation.dirtyStateObserved !== shouldBeDirty
  ) {
    throw new Error("Clone observation did not satisfy the T1 auth/isolation contract");
  }
}

async function assertWorkerStopped(): Promise<void> {
  const socketPath = path.join(runtimeRoot, "run", "oracle.sock");
  const socketPresent = await lstat(socketPath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (!socketPresent) return;
  const client = new OracleClient({
    socketPath,
  });
  try {
    await client.getWorker();
  } catch (error) {
    throw new Error("An Oracle v2 worker socket exists but stopped ownership cannot be proven", {
      cause: error,
    });
  } finally {
    client.close();
  }
  throw new Error("Oracle v2 worker is running; stop it before the T1 clone proof");
}

async function assertProfileUnused(profileDir: string, label: string): Promise<void> {
  if ((await findManagedBrowserProcessesUsingProfile(profileDir)).length > 0) {
    throw new Error(`A managed browser process still owns the ${label}`);
  }
}

function expectZero(value: number, label: string): 0 {
  if (value !== 0) throw new Error(`T1 clone proof observed ${value} ${label}`);
  return 0;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
