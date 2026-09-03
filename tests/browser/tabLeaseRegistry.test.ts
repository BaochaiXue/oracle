import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  normalizeMaxConcurrentTabs,
  readBrowserTargetRegistry,
} from "../../src/browser/tabLeaseRegistry.js";

describe("tabLeaseRegistry", () => {
  test("normalizes the concurrent tab limit", () => {
    expect(normalizeMaxConcurrentTabs(undefined)).toBe(3);
    expect(normalizeMaxConcurrentTabs("4")).toBe(4);
    expect(normalizeMaxConcurrentTabs(0)).toBe(3);
    expect(normalizeMaxConcurrentTabs("nope")).toBe(3);
  });

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const logger = vi.fn();
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const third = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      let resolved = false;
      const fourthPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
        logger,
      }).then((lease) => {
        resolved = true;
        return lease;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(resolved).toBe(false);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Waiting for Oracle browser target slot"),
      );

      await first.release();
      const fourth = await fourthPromise;
      expect(resolved).toBe(true);

      await second.release();
      await third.release();
      await fourth.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops stale leases owned by dead pids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const stale = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "stale-session" },
        { pid: 123_456, isProcessAlive: () => true },
      );
      await stale.update({ chromeTargetId: "target-stale" });

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "fresh-session" },
        { isProcessAlive: (pid) => pid !== 123_456 },
      );
      await fresh.update({ chromeTargetId: "target-fresh", tabUrl: "https://chatgpt.com/c/1" });

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string; chromeTargetId?: string; tabUrl?: string }> };
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]).toMatchObject({
        sessionId: "fresh-session",
        chromeTargetId: "target-fresh",
        tabUrl: "https://chatgpt.com/c/1",
      });

      await fresh.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects other active leases before releasing a shared Chrome owner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "first-session",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "second-session",
      });

      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(true);

      await second.release();
      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(false);

      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs cleanup exactly once when concurrent runs release their final lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const firstCleanup = vi.fn(async () => undefined);
      const secondCleanup = vi.fn(async () => undefined);

      await Promise.all([
        first.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await firstCleanup();
          },
        }),
        second.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await secondCleanup();
          },
        }),
      ]);

      expect(firstCleanup.mock.calls.length + secondCleanup.mock.calls.length).toBe(1);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("releases the registry lock before final-lease cleanup completes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      let finishCleanup!: () => void;
      let signalCleanupStarted!: () => void;
      const cleanupStarted = new Promise<void>((resolve) => {
        signalCleanupStarted = resolve;
      });
      const currentRelease = current.release({
        onRelease: async ({ isLastLease }) => {
          expect(isLastLease).toBe(true);
          signalCleanupStarted();
          await new Promise<void>((resolveCleanup) => {
            finishCleanup = resolveCleanup;
          });
        },
      });
      await cleanupStarted;

      const next = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
      });

      finishCleanup();
      await currentRelease;
      await next.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces final-lease cleanup failures after committing the release", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
      });

      await expect(
        lease.release({
          onRelease: async () => {
            throw new Error("synthetic drain failure");
          },
        }),
      ).rejects.toThrow("synthetic drain failure");

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("durably registers target ownership together with its active lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-target-ownership-"));
    try {
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "project-sources-session",
        ownerKind: "project-sources",
        purpose: "project-sources",
      });
      await lease.update({
        chromeHost: "127.0.0.1",
        chromePort: 9333,
        chromeTargetId: "project-sources-target",
        tabUrl: "https://chatgpt.com/g/g-p-project/project",
        ownsTarget: true,
      });

      let snapshot = await readBrowserTargetRegistry(dir);
      expect(snapshot.leases[0]).toMatchObject({
        chromeTargetId: "project-sources-target",
        ownerKind: "project-sources",
      });
      expect(snapshot.targets).toEqual([
        expect.objectContaining({
          targetId: "project-sources-target",
          ownerKind: "project-sources",
          disposition: "active",
          sessionId: "project-sources-session",
        }),
      ]);

      await lease.setTargetDisposition("recoverable", { recoveryKind: "awaiting-response" });
      await lease.release();
      snapshot = await readBrowserTargetRegistry(dir);
      expect(snapshot.leases).toEqual([]);
      expect(snapshot.targets[0]).toMatchObject({
        targetId: "project-sources-target",
        disposition: "recoverable",
        recoveryKind: "awaiting-response",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to replace the exact target identity of an owned lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-target-identity-"));
    try {
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "stable-target-session",
      });
      await lease.update({
        chromeTargetId: "created-cdp-target",
        tabUrl: "about:blank",
        ownsTarget: true,
      });

      await expect(
        lease.update({
          chromeTargetId: "session-scoped-target-info-id",
          tabUrl: "https://chatgpt.com/c/stable",
        }),
      ).rejects.toThrow(/owned target identity/i);

      const snapshot = await readBrowserTargetRegistry(dir);
      expect(snapshot.leases[0]?.chromeTargetId).toBe("created-cdp-target");
      expect(snapshot.targets.map((target) => target.targetId)).toEqual(["created-cdp-target"]);
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
