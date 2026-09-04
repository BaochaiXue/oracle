import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { OracleProviderFixture } from "../../apps/oracle-provider-fixture/src/index.js";
import {
  dirtyAttemptSandboxWithoutSend,
  monitorPotentialSubmissions,
  observeAttemptSandboxPage,
  observeStableAttemptSandboxPage,
  type AttemptSandboxPageObservation,
} from "../../packages/chatgpt-adapter/src/index.js";
import {
  acceptAuthSeedCandidate,
  cleanupAttemptSandbox,
  createAttemptSandbox,
  createAuthSeedCandidate,
  digestProfile,
  launchAttemptBrowserRuntime,
  listAttemptSandboxDirectories,
  managedBrowserTestHooks,
  observeManagedBrowserProcess,
  readAuthSeed,
  readAuthSeedCertification,
  withAuthSeedCloneLock,
  withAuthSeedRefreshLock,
  writeAttemptProcessReceipt,
  type AuthSeedCloneProofReceipt,
  type LaunchManagedBrowser,
  type ObservedManagedBrowserProcess,
} from "../../packages/oracle-browser-runtime/src/index.js";
import { findFixtureBrowserExecutable } from "./browser-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-attempt-sandbox-"));
  roots.push(root);
  return root;
}

function seedSource(root: string): string {
  const source = path.join(root, "browser-profile");
  mkdirSync(path.join(source, "Default"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(source, "Local State"), '{"profile":{"last_used":"Default"}}\n');
  writeFileSync(path.join(source, "Default", "Preferences"), '{"fixture":true}\n');
  return source;
}

describe("Oracle disposable attempt sandboxes", () => {
  test("seed refresh and clone locks exclude one another", async () => {
    const runtimeRoot = temporaryRoot();
    let releaseShared!: () => void;
    let sharedEntered!: () => void;
    const sharedRelease = new Promise<void>((resolve) => (releaseShared = resolve));
    const entered = new Promise<void>((resolve) => (sharedEntered = resolve));
    const shared = withAuthSeedCloneLock(runtimeRoot, async () => {
      sharedEntered();
      await sharedRelease;
    });
    await entered;
    await expect(
      withAuthSeedRefreshLock(runtimeRoot, async () => undefined, { timeoutMs: 20 }),
    ).rejects.toThrow(/exclusive auth-seed lock/i);
    releaseShared();
    await shared;

    let releaseExclusive!: () => void;
    let exclusiveEntered!: () => void;
    const exclusiveRelease = new Promise<void>((resolve) => (releaseExclusive = resolve));
    const exclusiveReady = new Promise<void>((resolve) => (exclusiveEntered = resolve));
    const exclusive = withAuthSeedRefreshLock(runtimeRoot, async () => {
      exclusiveEntered();
      await exclusiveRelease;
    });
    await exclusiveReady;
    await expect(
      withAuthSeedCloneLock(runtimeRoot, async () => undefined, { timeoutMs: 20 }),
    ).rejects.toThrow(/shared auth-seed lock/i);
    releaseExclusive();
    await exclusive;
  }, 20_000);

  test("waits through delayed restored state before classifying a clone start", async () => {
    const clean = sandboxPageObservation();
    const restored: AttemptSandboxPageObservation = {
      ...clean,
      composerEmpty: false,
      attachmentPresent: true,
    };
    let clock = 0;
    const observation = await observeStableAttemptSandboxPage(
      {} as Page,
      {
        marker: "delayed-restoration",
        filename: "delayed-restoration.md",
        timeoutMs: 1_000,
        quietPeriodMs: 200,
        pollIntervalMs: 50,
      },
      {
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
        waitForReady: async () => undefined,
        observe: async () => (clock < 150 ? clean : restored),
      },
    );
    expect(observation).toEqual(restored);
    expect(clock).toBeGreaterThanOrEqual(350);
  });

  test("atomically clones, isolates, cleans, and accepts one unchanged seed generation", async () => {
    const runtimeRoot = temporaryRoot();
    const sourceProfile = seedSource(runtimeRoot);
    const sourceBefore = readFileSync(path.join(sourceProfile, "Default", "Preferences"), "utf8");
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: sourceProfile,
    });
    const candidateRoot = path.dirname(candidate.profileRealpath);
    expect(candidate.profileDigest).toBe(await digestProfile(candidate.profileRealpath));
    expect(readFileSync(path.join(sourceProfile, "Default", "Preferences"), "utf8")).toBe(
      sourceBefore,
    );

    const cloneA = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_fixture_a",
      turnAttemptId: "attempt_fixture_a",
      purpose: "probe",
    });
    if (process.platform !== "win32") {
      expect(statSync(cloneA.directory).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(cloneA.directory, "owner.json")).mode & 0o777).toBe(0o400);
    }
    writeFileSync(path.join(cloneA.profileDir, "retained-draft"), "synthetic marker\n");
    writeFileSync(path.join(cloneA.profileDir, "retained-attachment"), "synthetic file\n");
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: cloneA.directory,
          dependencies: { findProcessesUsingProfile: noProfileProcesses },
        })
      ).status,
    ).toBe("deleted");

    const cloneB = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_fixture_b",
      turnAttemptId: "attempt_fixture_b",
      purpose: "probe",
    });
    expect(existsSync(path.join(cloneB.profileDir, "retained-draft"))).toBe(false);
    expect(existsSync(path.join(cloneB.profileDir, "retained-attachment"))).toBe(false);
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: cloneB.directory,
          dependencies: { findProcessesUsingProfile: noProfileProcesses },
        })
      ).status,
    ).toBe("deleted");
    expect(await digestProfile(candidate.profileRealpath)).toBe(candidate.profileDigest);
    expect(await listAttemptSandboxDirectories(runtimeRoot)).toEqual([]);

    const proof = passingCloneProof(candidate.candidateId, candidate.profileDigest, {
      cloneA: cloneA.sandboxId,
      cloneB: cloneB.sandboxId,
    });
    const certification = await acceptAuthSeedCandidate({
      runtimeRoot,
      candidateRoot,
      cloneProof: proof,
    });
    const seed = await readAuthSeed(runtimeRoot);
    expect(seed).toMatchObject({
      schemaVersion: "oracle.auth-seed.v1",
      profileDigest: candidate.profileDigest,
    });
    expect(seed!.generation).toBe(certification.seedGeneration);
    expect(seed!.generation).not.toBe(candidate.candidateId);
    expect(await readAuthSeedCertification(runtimeRoot)).toEqual(certification);
    expect(readFileSync(path.join(sourceProfile, "Default", "Preferences"), "utf8")).toBe(
      sourceBefore,
    );
    const forbiddenLaunches: Parameters<LaunchManagedBrowser>[0][] = [];
    await expect(
      launchAttemptBrowserRuntime({
        sandboxDirectory: path.dirname(seed!.profileRealpath),
        headless: true,
        inspection: {
          chromeForTestingExecutablePath: "/runtime/chrome",
          executableExists: () => true,
        },
        launchManagedBrowser: fakeAttemptLaunch(forbiddenLaunches, seed!.profileRealpath),
      }),
    ).rejects.toThrow(/owner marker|attempts directory/i);
    expect(forbiddenLaunches).toEqual([]);
  });

  test("rejects an unreceipted seed and removes an incomplete clone before publication", async () => {
    const runtimeRoot = temporaryRoot();
    const sourceProfile = seedSource(runtimeRoot);
    await expect(
      createAttemptSandbox({
        runtimeRoot,
        seed: {
          generation: "forged",
          profileRealpath: realpathSync(sourceProfile),
          profileDigest: await digestProfile(sourceProfile),
        },
        jobId: "job_forged_seed",
        turnAttemptId: "attempt_forged_seed",
        purpose: "probe",
      }),
    ).rejects.toThrow(/exact profile realpath|neither an accepted seed nor one exact candidate/i);

    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: sourceProfile,
    });
    await expect(
      createAttemptSandbox({
        runtimeRoot,
        seed: candidate,
        jobId: "job_partial_clone",
        turnAttemptId: "attempt_partial_clone",
        purpose: "probe",
        copyProfile: async (_source, destination) => {
          mkdirSync(destination, { recursive: true });
          writeFileSync(path.join(destination, "partial"), "partial\n");
          throw new Error("injected clone failure");
        },
      }),
    ).rejects.toThrow(/injected clone failure/i);
    expect(readdirSync(path.join(runtimeRoot, "attempts"))).toEqual([]);
  });

  test("rejects an attempt sandbox as an auth-seed candidate source", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_no_copyback",
      turnAttemptId: "attempt_no_copyback",
      purpose: "probe",
    });
    await expect(
      createAuthSeedCandidate({
        runtimeRoot,
        sourceProfileDir: sandbox.profileDir,
      }),
    ).rejects.toThrow(/exact fixed migration profile/i);
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: sandbox.directory,
          dependencies: { findProcessesUsingProfile: noProfileProcesses },
        })
      ).status,
    ).toBe("deleted");
  });

  test("blocks seed acceptance while an abandoned staging clone remains", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const staging = path.join(runtimeRoot, "attempts", ".abandoned-clone.tmp");
    mkdirSync(path.join(staging, "profile"), { recursive: true });
    expect(await listAttemptSandboxDirectories(runtimeRoot)).toEqual([staging]);
    await expect(
      acceptAuthSeedCandidate({
        runtimeRoot,
        candidateRoot: path.dirname(candidate.profileRealpath),
        cloneProof: passingCloneProof(candidate.candidateId, candidate.profileDigest, {
          cloneA: "deleted-clone-a",
          cloneB: "deleted-clone-b",
        }),
      }),
    ).rejects.toThrow(/attempt sandboxes remain/i);
  });

  test("atomically reserves one sandbox for each logical attempt purpose", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    let copyStarted!: () => void;
    let continueCopy!: () => void;
    const started = new Promise<void>((resolve) => (copyStarted = resolve));
    const released = new Promise<void>((resolve) => (continueCopy = resolve));
    const createInput = {
      runtimeRoot,
      seed: candidate,
      jobId: "job_unique_attempt",
      turnAttemptId: "attempt_unique_attempt",
      purpose: "probe" as const,
    };
    const first = createAttemptSandbox({
      ...createInput,
      copyProfile: async (source, destination) => {
        copyStarted();
        await released;
        await cp(source, destination, { recursive: true });
      },
    });
    await started;
    const secondError = await createAttemptSandbox(createInput).catch((error: unknown) => error);
    continueCopy();
    const sandbox = await first;
    expect(secondError).toBeInstanceOf(Error);
    expect((secondError as Error).message).toMatch(/already own an attempt sandbox/i);
    expect(
      (await listAttemptSandboxDirectories(runtimeRoot)).map((entry) => realpathSync(entry)),
    ).toEqual([sandbox.directory]);
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: sandbox.directory,
          dependencies: { findProcessesUsingProfile: noProfileProcesses },
        })
      ).status,
    ).toBe("deleted");
  });

  test("reclaims auth-seed locks whose recorded processes are dead", async () => {
    const runtimeRoot = temporaryRoot();
    const lockRoot = path.join(runtimeRoot, "run", "auth-seed.lock");
    const exclusive = path.join(lockRoot, "exclusive");
    mkdirSync(lockRoot, { recursive: true });
    writeDeadLockOwner(exclusive, "exclusive");
    await expect(withAuthSeedCloneLock(runtimeRoot, async () => "clone-ready")).resolves.toBe(
      "clone-ready",
    );

    const reader = path.join(lockRoot, "readers", "dead-reader");
    mkdirSync(path.dirname(reader), { recursive: true });
    writeDeadLockOwner(reader, "shared");
    await expect(withAuthSeedRefreshLock(runtimeRoot, async () => "refresh-ready")).resolves.toBe(
      "refresh-ready",
    );
  });

  test("reclaims an auth-seed lock after its PID is reused", async () => {
    const runtimeRoot = temporaryRoot();
    const lockRoot = path.join(runtimeRoot, "run", "auth-seed.lock");
    const exclusive = path.join(lockRoot, "exclusive");
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      exclusive,
      `${JSON.stringify({
        schemaVersion: "oracle.auth-seed-lock-owner.v2",
        token: "dead-owner-reused-pid",
        pid: process.pid,
        processStartTime: "not-the-current-process-start-time",
        mode: "exclusive",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    await expect(withAuthSeedCloneLock(runtimeRoot, async () => "clone-ready")).resolves.toBe(
      "clone-ready",
    );
  });

  test("publishes complete auth-seed lock ownership atomically", async () => {
    const runtimeRoot = temporaryRoot();
    await withAuthSeedCloneLock(runtimeRoot, async () => {
      const readersRoot = path.join(runtimeRoot, "run", "auth-seed.lock", "readers");
      const readers = readdirSync(readersRoot);
      expect(readers).toHaveLength(1);
      const lockPath = path.join(readersRoot, readers[0]!);
      expect(statSync(lockPath).isFile()).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
        schemaVersion: "oracle.auth-seed-lock-owner.v2",
        pid: process.pid,
        processStartTime: expect.any(String),
        mode: "shared",
      });
    });
    await withAuthSeedRefreshLock(runtimeRoot, async () => {
      const lockPath = path.join(runtimeRoot, "run", "auth-seed.lock", "exclusive");
      expect(statSync(lockPath).isFile()).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
        schemaVersion: "oracle.auth-seed-lock-owner.v2",
        pid: process.pid,
        processStartTime: expect.any(String),
        mode: "exclusive",
      });
    });
  });

  test("rejects symlinked profile state instead of risking copyback outside the sandbox", async () => {
    const runtimeRoot = temporaryRoot();
    const sourceProfile = seedSource(runtimeRoot);
    const outside = path.join(runtimeRoot, "outside-profile-state");
    writeFileSync(outside, "must remain outside\n");
    symlinkSync(outside, path.join(sourceProfile, "Default", "linked-state"));
    await expect(
      createAuthSeedCandidate({ runtimeRoot, sourceProfileDir: sourceProfile }),
    ).rejects.toThrow(/unsupported symlink/i);
    expect(readFileSync(outside, "utf8")).toBe("must remain outside\n");
    expect(readdirSync(path.join(runtimeRoot, "auth-seed-candidates"))).toEqual([]);
  });

  test("blocks a foreign symlink cleanup target without touching its contents", async () => {
    const runtimeRoot = temporaryRoot();
    const outside = path.join(runtimeRoot, "outside");
    const attempts = path.join(runtimeRoot, "attempts");
    mkdirSync(outside, { recursive: true });
    mkdirSync(attempts, { recursive: true });
    writeFileSync(path.join(outside, "keep"), "keep\n");
    const link = path.join(attempts, "foreign-link");
    symlinkSync(outside, link);

    const cleanup = await cleanupAttemptSandbox({
      runtimeRoot,
      sandboxDirectory: link,
    });
    expect(cleanup).toMatchObject({
      status: "blocked",
      processStatus: "identity-unproven",
    });
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep\n");
  });

  test("never signals or deletes when the process identity is not exact", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_process",
      turnAttemptId: "attempt_process",
      purpose: "probe",
    });
    const processReceipt = await writeAttemptProcessReceipt(sandbox, {
      pid: 4242,
      processStartTime: "Fri Sep 4 01:02:03 2026",
      executableRealpath: "/runtime/chrome",
      profileRealpath: sandbox.profileDir,
      debugHost: "127.0.0.1",
      debugPort: 9444,
    });
    let signalCount = 0;
    const wrongProcess: ObservedManagedBrowserProcess = {
      pid: processReceipt.pid,
      processStartTime: processReceipt.processStartTime,
      command: "/runtime/chrome --user-data-dir=/foreign --remote-debugging-port=9444",
      executableRealpath: "/runtime/chrome",
    };
    const cleanup = await cleanupAttemptSandbox({
      runtimeRoot,
      sandboxDirectory: sandbox.directory,
      expectedOwner: sandbox.owner,
      dependencies: {
        observeProcess: async () => wrongProcess,
        closeOverCdp: async () => {
          throw new Error("must not close");
        },
        sendSignal: () => {
          signalCount += 1;
        },
      },
    });
    expect(cleanup.status).toBe("blocked");
    expect(cleanup.processStatus).toBe("identity-unproven");
    expect(signalCount).toBe(0);
    expect(existsSync(sandbox.directory)).toBe(true);
  });

  test("blocks cleanup when process inspection fails", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_process_unobservable",
      turnAttemptId: "attempt_process_unobservable",
      purpose: "probe",
    });
    await writeAttemptProcessReceipt(sandbox, {
      pid: 4444,
      processStartTime: "Fri Sep 4 01:04:05 2026",
      executableRealpath: "/runtime/chrome",
      profileRealpath: sandbox.profileDir,
      debugHost: "127.0.0.1",
      debugPort: 9655,
    });
    let signalCount = 0;
    const cleanup = await cleanupAttemptSandbox({
      runtimeRoot,
      sandboxDirectory: sandbox.directory,
      dependencies: {
        observeProcess: async () => {
          throw new Error("injected process inspection failure");
        },
        sendSignal: () => {
          signalCount += 1;
        },
      },
    });
    expect(cleanup).toMatchObject({
      status: "blocked",
      processStatus: "identity-unproven",
    });
    expect(cleanup.error).toMatch(/process inspection failure/i);
    expect(signalCount).toBe(0);
    expect(existsSync(sandbox.directory)).toBe(true);
  });

  test("does not classify a process inspection error as process exit", async () => {
    await expect(
      observeManagedBrowserProcess(process.pid, "/runtime/chrome", {
        processExists: async () => true,
        execProcess: async () => {
          throw new Error("injected ps permission failure");
        },
      }),
    ).rejects.toThrow(/process inspection failed.*permission failure/i);
  });

  test("blocks cleanup when a profile process exists without a process receipt", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_missing_process_receipt",
      turnAttemptId: "attempt_missing_process_receipt",
      purpose: "probe",
    });
    const cleanup = await cleanupAttemptSandbox({
      runtimeRoot,
      sandboxDirectory: sandbox.directory,
      dependencies: {
        findProcessesUsingProfile: async () => [
          { pid: 4545, processStartTime: "Fri Sep 4 01:05:06 2026" },
        ],
      },
    });
    expect(cleanup).toMatchObject({
      status: "blocked",
      processStatus: "identity-unproven",
    });
    expect(cleanup.error).toMatch(/no process receipt.*live process/i);
    expect(existsSync(sandbox.directory)).toBe(true);
  });

  test("closes an exact process receipt before deleting its sandbox", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_process_exact",
      turnAttemptId: "attempt_process_exact",
      purpose: "probe",
    });
    const processReceipt = await writeAttemptProcessReceipt(sandbox, {
      pid: 4343,
      processStartTime: "Fri Sep 4 01:03:04 2026",
      executableRealpath: "/runtime/chrome",
      profileRealpath: sandbox.profileDir,
      debugHost: "127.0.0.1",
      debugPort: 9555,
    });
    let running = true;
    let closeCount = 0;
    const exactProcess: ObservedManagedBrowserProcess = {
      pid: processReceipt.pid,
      processStartTime: processReceipt.processStartTime,
      command: `/runtime/chrome --user-data-dir=${sandbox.profileDir} --remote-debugging-port=9555`,
      executableRealpath: "/runtime/chrome",
    };
    const cleanup = await cleanupAttemptSandbox({
      runtimeRoot,
      sandboxDirectory: sandbox.directory,
      dependencies: {
        observeProcess: async () => (running ? exactProcess : undefined),
        closeOverCdp: async () => {
          closeCount += 1;
          running = false;
        },
        wait: async () => undefined,
        findProcessesUsingProfile: noProfileProcesses,
      },
    });
    expect(cleanup).toMatchObject({ status: "deleted", processStatus: "stopped" });
    expect(closeCount).toBe(1);
    expect(existsSync(sandbox.directory)).toBe(false);
  });

  test("launches only the marked sandbox and permits only one page", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_runtime",
      turnAttemptId: "attempt_runtime",
      purpose: "probe",
    });
    const launches: Parameters<LaunchManagedBrowser>[0][] = [];
    await expect(
      launchAttemptBrowserRuntime({
        sandboxDirectory: path.dirname(candidate.profileRealpath),
        headless: true,
        inspection: {
          chromeForTestingExecutablePath: "/runtime/chrome",
          executableExists: () => true,
        },
        launchManagedBrowser: fakeAttemptLaunch(launches, candidate.profileRealpath),
      }),
    ).rejects.toThrow(/owner marker|attempts directory/i);
    expect(launches).toEqual([]);
    const runtime = await launchAttemptBrowserRuntime({
      sandboxDirectory: sandbox.directory,
      headless: true,
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome",
        executableExists: () => true,
      },
      launchManagedBrowser: fakeAttemptLaunch(launches, sandbox.profileDir),
    });
    await runtime.openPage("https://fixture.invalid/");
    await expect(runtime.openPage("https://fixture.invalid/second")).rejects.toThrow(
      /only one page/i,
    );
    await runtime.close();
    expect(launches).toEqual([
      {
        executablePath: "/runtime/chrome",
        profileDir: sandbox.profileDir,
        headless: true,
        singlePageLifetime: true,
        captureProcessIdentity: true,
      },
    ]);
    await expect(writeAttemptProcessReceipt(sandbox, runtime.processReceipt)).rejects.toMatchObject(
      { code: "EEXIST" },
    );
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: sandbox.directory,
          dependencies: {
            observeProcess: noObservedProcess,
            findProcessesUsingProfile: noProfileProcesses,
          },
        })
      ).status,
    ).toBe("deleted");
  });

  test("returns one restored recovery page without opening an alternate page", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_recovery_page",
      turnAttemptId: "attempt_recovery_page",
      purpose: "commit-recovery",
    });
    const recoveryPage = { isClosed: () => false } as unknown as Page;
    let alternateOpenCount = 0;
    const runtime = await launchAttemptBrowserRuntime({
      sandboxDirectory: sandbox.directory,
      headless: true,
      preserveWindowNames: ["oracle-v2-at-risk:fixture"],
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome",
        executableExists: () => true,
      },
      launchManagedBrowser: async (input) => ({
        context: { pages: () => [recoveryPage] } as unknown as BrowserContext,
        browserVersion: "test-browser",
        executablePath: input.executablePath,
        restoredPageCount: 0,
        preservedPages: () => [recoveryPage],
        processIdentity: {
          pid: 5252,
          processStartTime: "Fri Sep 4 02:04:05 2026",
          executableRealpath: input.executablePath,
          profileRealpath: sandbox.profileDir,
          debugHost: "127.0.0.1",
          debugPort: 9766,
        },
        openPage: async () => {
          alternateOpenCount += 1;
          return { isClosed: () => false } as unknown as Page;
        },
        close: async () => undefined,
      }),
    });
    expect(runtime.receipt.restoredPageCount).toBe(0);
    await expect(runtime.openPage("https://fixture.invalid/alternate")).resolves.toBe(recoveryPage);
    await expect(runtime.openPage("https://fixture.invalid/second")).rejects.toThrow(
      /only one page/i,
    );
    expect(alternateOpenCount).toBe(0);
    await runtime.close();
    expect(
      (
        await cleanupAttemptSandbox({
          runtimeRoot,
          sandboxDirectory: sandbox.directory,
          dependencies: {
            observeProcess: noObservedProcess,
            findProcessesUsingProfile: noProfileProcesses,
          },
        })
      ).status,
    ).toBe("deleted");
  });

  test("late recovery selection closes an in-flight alternate target", async () => {
    const ordinary = fakeClosablePage();
    const recovery = fakeClosablePage();
    const ownedPages = new Set<Page>([ordinary.page]);
    const preservedPages = new Set<Page>();
    const selected = await managedBrowserTestHooks.preserveManagedPage(recovery.page, {
      ownedPages,
      preservedPages,
      singlePageLifetime: true,
      ownPage: (page) => ownedPages.add(page),
    });
    expect(selected).toBe(recovery.page);
    expect(ordinary.closed()).toBe(true);
    expect(recovery.closed()).toBe(false);
    expect([...ownedPages].filter((page) => !page.isClosed())).toEqual([recovery.page]);
    expect([...preservedPages]).toEqual([recovery.page]);
  });

  test("reattaches a late recovery page after the first open has resolved", async () => {
    const runtimeRoot = temporaryRoot();
    const candidate = await createAuthSeedCandidate({
      runtimeRoot,
      sourceProfileDir: seedSource(runtimeRoot),
    });
    const sandbox = await createAttemptSandbox({
      runtimeRoot,
      seed: candidate,
      jobId: "job_late_recovery_page",
      turnAttemptId: "attempt_late_recovery_page",
      purpose: "commit-recovery",
    });
    const ordinary = fakeClosablePage();
    const recovery = fakeClosablePage();
    let preservedPages: Page[] = [];
    let alternateOpenCount = 0;
    const runtime = await launchAttemptBrowserRuntime({
      sandboxDirectory: sandbox.directory,
      headless: true,
      preserveWindowNames: ["oracle-v2-at-risk:late"],
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome",
        executableExists: () => true,
      },
      launchManagedBrowser: async (input) => ({
        context: { pages: () => preservedPages } as unknown as BrowserContext,
        browserVersion: "test-browser",
        executablePath: input.executablePath,
        restoredPageCount: 0,
        preservedPages: () => preservedPages,
        processIdentity: {
          pid: 5353,
          processStartTime: "Fri Sep 4 02:05:06 2026",
          executableRealpath: input.executablePath,
          profileRealpath: sandbox.profileDir,
          debugHost: "127.0.0.1",
          debugPort: 9866,
        },
        openPage: async () => {
          alternateOpenCount += 1;
          return ordinary.page;
        },
        close: async () => undefined,
      }),
    });
    await expect(runtime.openPage("https://fixture.invalid/ordinary")).resolves.toBe(ordinary.page);
    await ordinary.page.close({ runBeforeUnload: false });
    preservedPages = [recovery.page];
    await expect(runtime.openPage("https://fixture.invalid/recover")).resolves.toBe(recovery.page);
    await expect(runtime.openPage("https://fixture.invalid/third")).rejects.toThrow(
      /only one page/i,
    );
    expect(alternateOpenCount).toBe(1);
    await runtime.close();
  });

  test.skipIf(!findFixtureBrowserExecutable())(
    "destroys a dirty browser clone and starts the next clone clean with zero Send",
    async () => {
      const executablePath = findFixtureBrowserExecutable();
      if (!executablePath) throw new Error("Fixture browser executable is unavailable");
      const runtimeRoot = temporaryRoot();
      const sourceProfile = seedSource(runtimeRoot);
      const candidate = await createAuthSeedCandidate({
        runtimeRoot,
        sourceProfileDir: sourceProfile,
      });
      const fixture = new OracleProviderFixture();
      const marker = `oracle-no-send-${crypto.randomUUID()}`;
      const filename = "oracle-attempt-no-send.txt";
      await fixture.start();
      try {
        const cloneA = await createAttemptSandbox({
          runtimeRoot,
          seed: candidate,
          jobId: "job_clone_a",
          turnAttemptId: "attempt_clone_a",
          purpose: "probe",
        });
        const runtimeA = await launchAttemptBrowserRuntime({
          sandboxDirectory: cloneA.directory,
          headless: true,
          inspection: { chromeForTestingExecutablePath: executablePath },
        });
        const pageA = await runtimeA.openPage(fixture.urlFor("clone-a"));
        const monitorA = monitorPotentialSubmissions(pageA);
        const initialA = await observeAttemptSandboxPage(pageA, { marker, filename });
        expect(initialA).toMatchObject({
          composerEmpty: true,
          markerPresent: false,
          attachmentPresent: false,
          recoveryWindowNamePresent: false,
          recoveryStoragePresent: false,
        });
        const dirtyA = await dirtyAttemptSandboxWithoutSend(pageA, {
          marker,
          filename,
          timeoutMs: 5_000,
        });
        await pageA.evaluate(() => {
          window.name = "oracle-v2-recovery-fixture";
          localStorage.setItem("oracle-v2-recovery-fixture", "present");
        });
        expect(dirtyA).toMatchObject({
          markerPresent: true,
          attachmentPresent: true,
          promptSubmitted: false,
        });
        expect(monitorA.count()).toBe(0);
        monitorA.stop();
        await runtimeA.close();
        expect(
          (
            await cleanupAttemptSandbox({
              runtimeRoot,
              sandboxDirectory: cloneA.directory,
            })
          ).status,
        ).toBe("deleted");

        const cloneB = await createAttemptSandbox({
          runtimeRoot,
          seed: candidate,
          jobId: "job_clone_b",
          turnAttemptId: "attempt_clone_b",
          purpose: "probe",
        });
        const runtimeB = await launchAttemptBrowserRuntime({
          sandboxDirectory: cloneB.directory,
          headless: true,
          inspection: { chromeForTestingExecutablePath: executablePath },
        });
        const pageB = await runtimeB.openPage(fixture.urlFor("clone-b"));
        const monitorB = monitorPotentialSubmissions(pageB);
        const cleanB = await observeAttemptSandboxPage(pageB, { marker, filename });
        expect(cleanB).toMatchObject({
          composerEmpty: true,
          markerPresent: false,
          attachmentPresent: false,
          attachmentInputSelected: false,
          recoveryWindowNamePresent: false,
          recoveryStoragePresent: false,
          promptSubmitted: false,
        });
        expect(runtimeB.receipt.restoredPageCount).toBe(0);
        expect(monitorB.count()).toBe(0);
        monitorB.stop();
        await runtimeB.close();
        expect(
          (
            await cleanupAttemptSandbox({
              runtimeRoot,
              sandboxDirectory: cloneB.directory,
            })
          ).status,
        ).toBe("deleted");
        expect(fixture.totalSendCount()).toBe(0);
        expect(await digestProfile(candidate.profileRealpath)).toBe(candidate.profileDigest);
        expect(await listAttemptSandboxDirectories(runtimeRoot)).toEqual([]);
      } finally {
        await fixture.stop();
      }
    },
    120_000,
  );
});

function passingCloneProof(
  candidateId: string,
  digest: string,
  sandboxes: { cloneA: string; cloneB: string },
): AuthSeedCloneProofReceipt {
  return {
    schemaVersion: "oracle.auth-seed-clone-proof.v1",
    candidateId,
    seedProfileDigestBefore: digest,
    seedProfileDigestAfter: digest,
    browserRuntimeId: "managed-chrome-for-testing-direct-cdp:test",
    executableRealpath: "/runtime/chrome",
    cloneA: {
      sandboxId: sandboxes.cloneA,
      authenticated: true,
      modelVerified: true,
      effortVerified: true,
      initiallyClean: true,
      dirtyStateObserved: true,
      inheritedStateObserved: false,
      promptSubmitted: false,
    },
    cloneACleanup: {
      schemaVersion: "oracle.attempt-sandbox-cleanup.v1",
      sandboxId: sandboxes.cloneA,
      status: "deleted",
      processStatus: "already-stopped",
      completedAt: new Date().toISOString(),
    },
    cloneB: {
      sandboxId: sandboxes.cloneB,
      authenticated: true,
      modelVerified: true,
      effortVerified: true,
      initiallyClean: true,
      dirtyStateObserved: false,
      inheritedStateObserved: false,
      promptSubmitted: false,
    },
    cloneBCleanup: {
      schemaVersion: "oracle.attempt-sandbox-cleanup.v1",
      sandboxId: sandboxes.cloneB,
      status: "deleted",
      processStatus: "already-stopped",
      completedAt: new Date().toISOString(),
    },
    sendEventCount: 0,
    remainingAttemptCount: 0,
    completedAt: new Date().toISOString(),
  };
}

function fakeAttemptLaunch(
  launches: Parameters<LaunchManagedBrowser>[0][],
  profileRealpath: string,
): LaunchManagedBrowser {
  return async (input) => {
    launches.push(input);
    let closed = false;
    return {
      context: { pages: () => [] } as unknown as BrowserContext,
      browserVersion: "test-browser",
      executablePath: input.executablePath,
      restoredPageCount: 0,
      preservedPages: () => [],
      processIdentity: {
        pid: 5151,
        processStartTime: "Fri Sep 4 02:03:04 2026",
        executableRealpath: input.executablePath,
        profileRealpath,
        debugHost: "127.0.0.1",
        debugPort: 9666,
      },
      openPage: async () => ({ isClosed: () => closed }) as unknown as Page,
      close: async () => {
        closed = true;
      },
    };
  };
}

const noProfileProcesses = async (): Promise<[]> => [];
const noObservedProcess = async (): Promise<undefined> => undefined;

function writeDeadLockOwner(lockPath: string, mode: "shared" | "exclusive"): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      schemaVersion: "oracle.auth-seed-lock-owner.v2",
      token: `dead-${mode}`,
      pid: 999_999,
      processStartTime: "dead-process-start-time",
      mode,
      createdAt: new Date().toISOString(),
    })}\n`,
  );
}

function fakeClosablePage(): { page: Page; closed: () => boolean } {
  let closed = false;
  const page = {
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
  } as unknown as Page;
  return { page, closed: () => closed };
}

function sandboxPageObservation(): AttemptSandboxPageObservation {
  return {
    schemaVersion: "oracle.attempt-sandbox-page-observation.v1",
    composerPresent: true,
    composerEmpty: true,
    markerPresent: false,
    attachmentPresent: false,
    attachmentInputSelected: false,
    userTurnPresent: false,
    conversationRoutePresent: false,
    recoveryWindowNamePresent: false,
    recoveryStoragePresent: false,
    promptSubmitted: false,
  };
}
