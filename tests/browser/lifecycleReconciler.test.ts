import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  planOwnedTargetReconciliation,
  reconcileBrowserTargets,
  type ReconcileTarget,
} from "../../src/browser/lifecycleReconciler.js";
import type { BrowserTargetRegistryFile } from "../../src/browser/tabLeaseRegistry.js";
import {
  acquireBrowserTabLease,
  registerBrowserOwnedTarget,
} from "../../src/browser/tabLeaseRegistry.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

const profile = "/tmp/oracle-profile";

function session(
  id: string,
  status: string,
  runtime: NonNullable<NonNullable<SessionMetadata["browser"]>["runtime"]>,
  completedAt = "2026-08-22T00:00:00.000Z",
): SessionMetadata {
  return {
    id,
    createdAt: "2026-08-22T00:00:00.000Z",
    completedAt,
    status,
    options: {},
    browser: { runtime: { userDataDir: profile, ...runtime } },
  };
}

describe("planOwnedTargetReconciliation", () => {
  const targets = [
    { targetId: "done-target", type: "page", url: "https://chatgpt.com/c/done-conv" },
    { targetId: "recover-target", type: "page", url: "https://chatgpt.com/c/recover" },
    { targetId: "manual-target", type: "page", url: "https://example.com/notes" },
    { targetId: "blank-target", type: "page", url: "about:blank" },
  ];

  test("closes exact completed ownership while preserving recovery and unknown manual pages", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("done", "completed", {
          chromeTargetId: "done-target",
          conversationId: "done-conv",
          browserDisposition: "completed",
        }),
        session("recover", "error", {
          chromeTargetId: "recover-target",
          conversationId: "recover",
          browserDisposition: "recoverable",
          recoveryKind: "awaiting-response",
          recoveryExpiresAt: "2026-08-23T00:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["done-target", "blank-target"]);
    expect(plan.protectedTargetIds).toEqual(["recover-target"]);
    expect(plan.unknownTargetIds).toEqual(["manual-target", "blank-target"]);
    expect(plan.unknownBlockingTargetIds).toEqual(["manual-target"]);
  });

  test("matches completed legacy sessions by exact stable conversation id", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("legacy", "completed", {
          chromeTargetId: "stale-target-id",
          conversationId: "done-conv",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["blank-target"]);
    expect(plan.untrackedChatgptTargetIds).toContain("done-target");
  });

  test("expires recovery holds and never uses a first-page fallback", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-24T00:00:00.000Z"),
      sessions: [
        session("expired", "error", {
          chromeTargetId: "missing-target",
          conversationId: "missing-conversation",
          browserDisposition: "recoverable",
          recoveryKind: "draft-retained",
          recoveryExpiresAt: "2026-08-22T02:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["blank-target"]);
    expect(plan.protectedTargetIds).toEqual([]);
    expect(plan.unknownTargetIds).toEqual([
      "done-target",
      "recover-target",
      "manual-target",
      "blank-target",
    ]);
    expect(plan.unknownBlockingTargetIds).toEqual([
      "done-target",
      "recover-target",
      "manual-target",
    ]);
  });

  test("a live recovery receipt overrides a completed receipt for the same exact target", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
      sessions: [
        session("done", "completed", {
          chromeTargetId: "done-target",
          browserDisposition: "completed",
        }),
        session("recover", "error", {
          chromeTargetId: "done-target",
          browserDisposition: "recoverable",
          recoveryExpiresAt: "2026-08-23T00:00:00.000Z",
        }),
      ],
      targets,
    });

    expect(plan.closeTargetIds).toEqual(["blank-target"]);
    expect(plan.protectedTargetIds).toEqual(["done-target"]);
  });

  test("preserves a target whose durable harvest state is still running", () => {
    const runningHarvest = session("harvest-running", "error", {
      chromeTargetId: "done-target",
    });
    runningHarvest.browser = {
      ...(runningHarvest.browser ?? {}),
      harvest: { state: "running" } as NonNullable<SessionMetadata["browser"]>["harvest"],
    };
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [runningHarvest],
      targets,
    });

    expect(plan.protectedTargetIds).toContain("done-target");
    expect(plan.closeTargetIds).not.toContain("done-target");
  });
});

function registry(
  targets: BrowserTargetRegistryFile["targets"] = [],
  leases: BrowserTargetRegistryFile["leases"] = [],
): BrowserTargetRegistryFile {
  return { version: 2, leases, targets };
}

describe("generic target reconciliation", () => {
  test("explicit dedicated-profile purge closes historical GPT pages and coalesces blanks", () => {
    const targets = [
      ...Array.from({ length: 10 }, (_, index) => ({
        targetId: `blank-${index}`,
        type: "page",
        url: index % 2 === 0 ? "about:blank" : "chrome://newtab/",
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        targetId: `gpt-${index}`,
        type: "page",
        url: `https://chatgpt.com/c/history-${index}`,
      })),
      { targetId: "worker-1", type: "service_worker", url: "https://chatgpt.com/sw.js" },
    ];

    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [],
      registry: registry(),
      targets,
      includeUntrackedChatgpt: true,
      ensureSentinel: true,
    });

    expect(plan.closeTargetIds).toHaveLength(19);
    expect(plan.untrackedChatgptTargetIds).toHaveLength(10);
    expect(plan.duplicateBlankTargetIds).toHaveLength(9);
    expect(plan.preservedTargetIds).toContain("blank-0");
    expect(plan.nonPageTargetIds).toEqual(["worker-1"]);
  });

  test("routine reconciliation preserves untracked ChatGPT and recoverable owned targets", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [
        session("recover", "error", {
          chromeTargetId: "recover-target",
          browserDisposition: "recoverable",
          recoveryKind: "awaiting-response",
          recoveryExpiresAt: "2026-08-23T00:00:00.000Z",
        }),
      ],
      registry: registry([
        {
          targetId: "recover-target",
          ownerKind: "recovery",
          purpose: "reattach",
          disposition: "recoverable",
          controllerPid: 123,
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-22T00:00:00.000Z",
        },
      ]),
      targets: [
        { targetId: "recover-target", type: "page", url: "https://chatgpt.com/c/recover" },
        { targetId: "manual-gpt", type: "page", url: "https://chatgpt.com/c/manual" },
      ],
      nowMs: Date.parse("2026-08-22T01:00:00.000Z"),
    });

    expect(plan.closeTargetIds).toEqual([]);
    expect(plan.preservedTargetIds).toEqual(["recover-target", "manual-gpt"]);
    expect(plan.untrackedChatgptTargetIds).toEqual(["manual-gpt"]);
  });

  test("closes completed generic owned targets from ChatGPT, Project Sources, and recovery", () => {
    const owned = (["chatgpt", "project-sources", "recovery"] as const).map((ownerKind, index) => ({
      targetId: `owned-${index}`,
      ownerKind,
      purpose: "test",
      disposition: "terminal" as const,
      controllerPid: 999,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }));
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [],
      registry: registry(owned),
      targets: owned.map((target) => ({
        targetId: target.targetId,
        type: "page",
        url: "https://example.test/owned",
      })),
    });
    expect(plan.terminalOwnedTargetIds).toEqual(["owned-0", "owned-1", "owned-2"]);
  });

  test("coalesces multiple registered sentinels instead of protecting every blank", () => {
    const sentinelRecords = ["sentinel-b", "sentinel-a"].map((id) => ({
      targetId: id,
      ownerKind: "sentinel" as const,
      purpose: "persistent-browser-sentinel",
      disposition: "sentinel" as const,
      controllerPid: process.pid,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }));
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [],
      registry: registry(sentinelRecords),
      targets: sentinelRecords.map((target) => ({
        targetId: target.targetId,
        type: "page",
        url: "about:blank",
      })),
      ensureSentinel: true,
    });

    expect(plan.sentinelTargetId).toBe("sentinel-a");
    expect(plan.closeTargetIds).toEqual(["sentinel-b"]);
    expect(plan.preservedTargetIds).toEqual(["sentinel-a"]);
    expect(plan.protectedTargetIds).toEqual([]);
  });

  test("closes the final blank when process lifetime does not require a sentinel", () => {
    const plan = planOwnedTargetReconciliation({
      profileDir: profile,
      sessions: [],
      registry: registry([
        {
          targetId: "idle-sentinel",
          ownerKind: "sentinel",
          purpose: "persistent-browser-sentinel",
          disposition: "sentinel",
          controllerPid: process.pid,
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-22T00:00:00.000Z",
        },
      ]),
      targets: [{ targetId: "idle-sentinel", type: "page", url: "about:blank" }],
      ensureSentinel: false,
    });

    expect(plan.sentinelTargetId).toBeUndefined();
    expect(plan.closeTargetIds).toEqual(["idle-sentinel"]);
    expect(plan.needsSentinel).toBe(false);
  });

  test("revalidates URL, type, leases, ownership, and session state immediately before close", async () => {
    let targets = [
      { targetId: "url-change", type: "page", url: "https://chatgpt.com/c/old" },
      { targetId: "became-leased", type: "page", url: "https://chatgpt.com/c/leased" },
      { targetId: "type-change", type: "page", url: "https://chatgpt.com/c/type" },
      { targetId: "ownership-change", type: "page", url: "https://chatgpt.com/c/owner" },
      { targetId: "session-change", type: "page", url: "https://chatgpt.com/c/session" },
    ];
    let currentRegistry = registry(
      targets.map((target) => ({
        targetId: target.targetId,
        ownerKind: "chatgpt" as const,
        purpose: "run",
        disposition: "terminal" as const,
        controllerPid: 1,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      })),
    );
    let currentSessions = [
      session("session-transition", "completed", {
        chromeTargetId: "session-change",
        browserDisposition: "completed",
      }),
    ];
    const closeTarget = vi.fn(async () => true);
    const receipt = await reconcileBrowserTargets(
      {
        profileDir: profile,
        host: "127.0.0.1",
        port: 9333,
        apply: true,
        logger: () => {},
      },
      {
        listTargets: async () => targets,
        listSessions: async () => currentSessions,
        readRegistry: async () => currentRegistry,
        closeTarget,
        beforeClose: async (targetId) => {
          if (targetId === "url-change") {
            targets = targets.map((target) =>
              target.targetId === targetId
                ? { ...target, url: "https://example.com/manual" }
                : target,
            );
          } else if (targetId === "became-leased") {
            currentRegistry = registry(currentRegistry.targets, [
              {
                id: "lease-new",
                pid: process.pid,
                ownerKind: "chatgpt",
                purpose: "run",
                chromeTargetId: targetId,
                createdAt: "2026-08-22T00:00:00.000Z",
                updatedAt: "2026-08-22T00:00:00.000Z",
              },
            ]);
          } else if (targetId === "type-change") {
            targets = targets.map((target) =>
              target.targetId === targetId ? { ...target, type: "worker" } : target,
            );
          } else if (targetId === "ownership-change") {
            currentRegistry = registry(
              currentRegistry.targets.map((target) =>
                target.targetId === targetId
                  ? { ...target, disposition: "active", controllerPid: process.pid }
                  : target,
              ),
            );
          } else if (targetId === "session-change") {
            currentSessions = [
              session("session-transition", "error", {
                chromeTargetId: "session-change",
                browserDisposition: "recoverable",
                recoveryExpiresAt: "2099-08-23T00:00:00.000Z",
              }),
            ];
          }
        },
        isProcessAlive: () => true,
        removeOwnedTarget: async () => {},
        writeReceipt: async () => {},
      },
    );

    expect(closeTarget).not.toHaveBeenCalled();
    expect(receipt.skippedTargetIds).toEqual([
      "url-change",
      "became-leased",
      "type-change",
      "ownership-change",
      "session-change",
    ]);
    expect(receipt.status).toBe("complete");
  });

  test("records failed cleanup and retries it on the next apply", async () => {
    const targets = [{ targetId: "terminal", type: "page", url: "https://chatgpt.com/c/done" }];
    const currentRegistry = registry([
      {
        targetId: "terminal",
        ownerKind: "chatgpt",
        purpose: "run",
        disposition: "terminal",
        controllerPid: 1,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
    ]);
    let succeeds = false;
    const receipts: Array<{ status: string; failedTargetIds: string[] }> = [];
    const deps = {
      listTargets: async () => targets,
      listSessions: async () => [],
      readRegistry: async () => currentRegistry,
      closeTarget: async () => succeeds,
      removeOwnedTarget: async () => {},
      writeReceipt: async (receipt: { status: string; failedTargetIds: string[] }) => {
        receipts.push(receipt);
      },
    };

    const failed = await reconcileBrowserTargets(
      { profileDir: profile, host: "127.0.0.1", port: 9333, apply: true, logger: () => {} },
      deps,
    );
    succeeds = true;
    const retried = await reconcileBrowserTargets(
      { profileDir: profile, host: "127.0.0.1", port: 9333, apply: true, logger: () => {} },
      deps,
    );

    expect(failed.status).toBe("failed");
    expect(failed.failedTargetIds).toEqual(["terminal"]);
    expect(retried.status).toBe("complete");
    expect(retried.closedTargetIds).toEqual(["terminal"]);
    expect(receipts.map((receipt) => receipt.status)).toEqual(["failed", "complete"]);
  });

  test("slow target closure does not block a new lease acquisition", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-reconcile-lock-"));
    try {
      await registerBrowserOwnedTarget(dir, {
        targetId: "terminal",
        ownerKind: "chatgpt",
        purpose: "run",
        disposition: "terminal",
        controllerPid: 1,
      });
      let releaseClose!: () => void;
      let closeStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        closeStarted = resolve;
      });
      const reconciliation = reconcileBrowserTargets(
        {
          profileDir: dir,
          host: "127.0.0.1",
          port: 9333,
          apply: true,
          logger: () => {},
        },
        {
          listTargets: async () => [
            { targetId: "terminal", type: "page", url: "https://chatgpt.com/c/done" },
          ],
          listSessions: async () => [],
          closeTarget: async () => {
            closeStarted();
            await new Promise<void>((resolve) => {
              releaseClose = resolve;
            });
            return true;
          },
          writeReceipt: async () => {},
        },
      );
      await started;
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 250,
        ownerKind: "chatgpt",
        purpose: "concurrent-run",
      });
      expect(lease.id).toBeTruthy();
      releaseClose();
      await reconciliation;
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("close-confirmation failure does not create a replacement while a page remains", async () => {
    const targets = [{ targetId: "terminal", type: "page", url: "https://chatgpt.com/c/done" }];
    const createTarget = vi.fn(async () => "sentinel-new");
    const result = await reconcileBrowserTargets(
      {
        profileDir: profile,
        host: "127.0.0.1",
        port: 9333,
        apply: true,
        ensureSentinel: true,
        logger: () => {},
      },
      {
        listTargets: async () => targets,
        listSessions: async () => [],
        readRegistry: async () =>
          registry([
            {
              targetId: "terminal",
              ownerKind: "chatgpt",
              purpose: "run",
              disposition: "terminal",
              controllerPid: 1,
              createdAt: "2026-08-22T00:00:00.000Z",
              updatedAt: "2026-08-22T00:00:00.000Z",
            },
          ]),
        closeTarget: async () => false,
        createTarget,
        removeOwnedTarget: async () => {},
        writeReceipt: async () => {},
      },
    );
    expect(result.status).toBe("failed");
    expect(createTarget).not.toHaveBeenCalled();
  });

  test("reconciles pages restored only after sentinel target creation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-reconcile-restore-"));
    try {
      let targets: ReconcileTarget[] = [];
      let restored = false;
      const result = await reconcileBrowserTargets(
        {
          profileDir: dir,
          host: "127.0.0.1",
          port: 9333,
          apply: true,
          includeUntrackedChatgpt: true,
          ensureSentinel: true,
          logger: () => {},
        },
        {
          listTargets: async () => [...targets],
          listSessions: async () => [],
          readRegistry: async () => registry(),
          createTarget: async () => {
            targets.push({ targetId: "created-sentinel", type: "page", url: "about:blank" });
            return "created-sentinel";
          },
          registerOwnedTarget: async () => {},
          removeOwnedTarget: async () => {},
          closeTarget: async (_port, id) => {
            targets = targets.filter((target) => target.targetId !== id);
            return true;
          },
          wait: async () => {
            if (restored) return;
            restored = true;
            targets.push(
              { targetId: "restored-chat", type: "page", url: "https://chatgpt.com/c/old" },
              { targetId: "restored-blank", type: "page", url: "about:blank" },
            );
          },
          writeReceipt: async () => {},
        },
      );

      expect(result.status).toBe("complete");
      expect(result.closedTargetIds).toEqual(
        expect.arrayContaining(["restored-chat", "restored-blank"]),
      );
      expect(targets.filter((target) => target.type === "page")).toHaveLength(1);
      expect(targets[0]?.url).toBe("about:blank");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("successful repeated and concurrent reconciliation converges idempotently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-reconcile-converge-"));
    try {
      let targets: ReconcileTarget[] = [{ targetId: "blank-0", type: "page", url: "about:blank" }];
      let counter = 0;
      const closeTarget = async (_port: number, id: string) => {
        targets = targets.filter((target) => target.targetId !== id);
        return true;
      };
      const createTarget = async () => {
        const id = `sentinel-${counter++}`;
        targets.push({ targetId: id, type: "page", url: "about:blank" });
        return id;
      };
      const run = () =>
        reconcileBrowserTargets(
          {
            profileDir: dir,
            host: "127.0.0.1",
            port: 9333,
            apply: true,
            ensureSentinel: true,
            logger: () => {},
          },
          {
            listTargets: async () => [...targets],
            listSessions: async () => [],
            closeTarget,
            createTarget,
          },
        );

      for (let index = 0; index < 5; index += 1) {
        const id = `run-${index}`;
        targets.push({ targetId: id, type: "page", url: `https://chatgpt.com/c/${index}` });
        await registerBrowserOwnedTarget(dir, {
          targetId: id,
          ownerKind: "chatgpt",
          purpose: "run",
          disposition: "terminal",
          controllerPid: 1,
        });
        await run();
      }
      await Promise.all([run(), run(), run()]);
      expect(targets.filter((target) => target.type === "page")).toHaveLength(1);
      expect(targets[0]?.url).toBe("about:blank");
      const final = await run();
      expect(final.closedTargetIds).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
