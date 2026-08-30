import { afterEach, describe, expect, test, vi } from "vitest";
import {
  printDedicatedBrowserHealResult,
  printDedicatedBrowserStatusResult,
  runDedicatedBrowserHeal,
  runDedicatedBrowserStatus,
} from "../../src/cli/dedicatedBrowser.js";
import type {
  DedicatedChromeInspection,
  DedicatedChromeMaintenanceReceipt,
} from "../../src/browser/dedicatedChromeSupervisor.js";
import type { BrowserTargetReconciliationReceipt } from "../../src/browser/lifecycleReconciler.js";

const profileDir = "/Users/example/.oracle/browser-profile";
const executable = "/Users/example/.oracle/browsers/chrome/140/chrome";

function inspection(overrides: Partial<DedicatedChromeInspection> = {}): DedicatedChromeInspection {
  return {
    state: "healthy-current",
    ownership: "managed-current",
    profileDir,
    profileRealpath: profileDir,
    configuredExecutablePath: executable,
    configuredExecutableRealpath: executable,
    installedExecutableRealpaths: [executable],
    installedBuildIds: { [executable]: "140" },
    recordedPid: 4100,
    recordedPort: 9333,
    observed: {
      pid: 4100,
      command: `${executable} --user-data-dir=${profileDir} --remote-debugging-port=9333`,
      executablePath: executable,
      executableRealpath: executable,
      processStartTime: "Sat Aug 30 12:00:00 2026",
    },
    debugPort: 9333,
    endpointReachable: true,
    receipt: null,
    metadataDrift: false,
    reason: "healthy",
    ...overrides,
  };
}

function reconciliation(
  overrides: Partial<BrowserTargetReconciliationReceipt> = {},
): BrowserTargetReconciliationReceipt {
  return {
    closeTargetIds: [],
    protectedTargetIds: [],
    unknownTargetIds: [],
    unknownBlockingTargetIds: [],
    preservedTargetIds: [],
    terminalOwnedTargetIds: [],
    duplicateBlankTargetIds: [],
    untrackedChatgptTargetIds: [],
    untrackedOtherTargetIds: [],
    nonPageTargetIds: [],
    needsSentinel: false,
    targetSnapshots: {},
    status: "complete",
    mode: "plan",
    profileDir,
    host: "127.0.0.1",
    port: 9333,
    includeUntrackedChatgpt: false,
    startedAt: "2026-08-30T04:00:00.000Z",
    completedAt: "2026-08-30T04:00:01.000Z",
    closedTargetIds: [],
    skippedTargetIds: [],
    failedTargetIds: [],
    ...overrides,
  };
}

function emptyRegistry() {
  return { version: 2 as const, leases: [], targets: [] };
}

describe("dedicated browser status and heal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("reports a compatible generation without exposing process details in default output", async () => {
    const result = await runDedicatedBrowserStatus(
      { profileDir },
      {
        inspect: vi.fn(async () =>
          inspection({
            state: "healthy-managed-compatible",
            ownership: "managed-compatible",
          }),
        ),
        readRegistry: vi.fn(async () => emptyRegistry()),
        profileInitialized: vi.fn(async () => true),
      },
    );
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    printDedicatedBrowserStatusResult(result);

    const text = output.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Dedicated browser: ready");
    expect(text).toContain("Generation: compatible update pending");
    expect(text).toContain("Action required: none");
    expect(text).not.toContain("4100");
    expect(text).not.toContain("9333");
    expect(text).not.toContain(profileDir);
    expect(text).not.toContain(executable);
  });

  test("keeps full inspection facts in JSON output", async () => {
    const result = await runDedicatedBrowserStatus(
      { profileDir },
      {
        inspect: vi.fn(async () => inspection()),
        readRegistry: vi.fn(async () => emptyRegistry()),
        profileInitialized: vi.fn(async () => true),
      },
    );
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    printDedicatedBrowserStatusResult(result, true);

    const text = output.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain('"pid": 4100');
    expect(text).toContain('"debugPort": 9333');
    expect(text).toContain(executable);
  });

  test("heal plan delegates to the shared supervisor without mutating or sending", async () => {
    const repair: DedicatedChromeMaintenanceReceipt = {
      mode: "heal",
      planOnly: true,
      action: "terminate-managed",
      stateBefore: "healthy-managed-compatible",
      changed: false,
      protectedState: false,
      reason: "roll over when idle",
    };
    const heal = vi.fn(async () => repair);

    const result = await runDedicatedBrowserHeal(
      { profileDir, plan: true },
      {
        inspect: vi.fn(async () =>
          inspection({
            state: "healthy-managed-compatible",
            ownership: "managed-compatible",
          }),
        ),
        readRegistry: vi.fn(async () => emptyRegistry()),
        profileInitialized: vi.fn(async () => true),
        reconcile: vi.fn(async () => reconciliation()),
        heal,
      },
    );

    expect(result.promptSubmitted).toBe(false);
    expect(result.reconciliation?.mode).toBe("plan");
    expect(heal).toHaveBeenCalledWith(
      expect.objectContaining({ planOnly: true, protectedState: false, lockHeld: false }),
    );
  });

  test("active work makes heal preserve the managed browser", async () => {
    const preserve: DedicatedChromeMaintenanceReceipt = {
      mode: "heal",
      planOnly: false,
      action: "preserve-protected",
      stateBefore: "healthy-current",
      stateAfter: "healthy-current",
      changed: false,
      protectedState: true,
      reason: "active work",
    };
    const heal = vi.fn(async () => preserve);
    const lock = { path: "/tmp/lock", lockId: "lock", release: vi.fn(async () => undefined) };

    const result = await runDedicatedBrowserHeal(
      { profileDir },
      {
        inspect: vi.fn(async () => inspection()),
        readRegistry: vi.fn(async () => ({
          version: 2 as const,
          leases: [
            {
              id: "lease",
              pid: process.pid,
              ownerKind: "chatgpt" as const,
              purpose: "browser-run",
              createdAt: "2026-08-30T04:00:00.000Z",
              updatedAt: "2026-08-30T04:00:00.000Z",
            },
          ],
          targets: [],
        })),
        profileInitialized: vi.fn(async () => true),
        processAlive: vi.fn(() => true),
        reconcile: vi.fn(async () => reconciliation({ mode: "apply" })),
        acquireLock: vi.fn(async () => lock),
        heal,
      },
    );

    expect(result.repair.action).toBe("preserve-protected");
    expect(heal).toHaveBeenCalledWith(expect.objectContaining({ protectedState: true }));
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  test("human-action output is concise and contains no pid, port, or path", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printDedicatedBrowserHealResult({
      status: {
        dedicatedBrowser: "ambiguous",
        generation: "ambiguous",
        consultations: { active: 0, recoverable: 0 },
        actionRequired: "close unverified browser",
        promptSubmitted: false,
      },
      repair: {
        mode: "heal",
        planOnly: false,
        action: "block-human-action",
        stateBefore: "ambiguous",
        stateAfter: "ambiguous",
        changed: false,
        protectedState: false,
        reason: `pid 4100 port 9333 profile ${profileDir}`,
      },
      promptSubmitted: false,
    });

    const text = output.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toBe(
      "Oracle found an unverified browser using its dedicated profile. No repair was attempted.\n",
    );
  });
});
