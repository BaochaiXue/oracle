import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

const baseMeta = {
  id: "sess-recover",
  createdAt: "2026-05-26T00:00:00.000Z",
  status: "completed",
  options: {},
  mode: "browser",
  cwd: "/tmp/recover-cwd",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      chromeHost: "127.0.0.1",
      chromePort: 9223,
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const completedHarvest = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 1,
  currentModelLabel: "GPT-5.5 Pro",
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  lastAssistantMarkdown: "## Recovered answer\n\nFull response captured.",
  lastAssistantText: "Recovered answer. Full response captured.",
  lastAssistantSnippet: "Recovered answer.",
  lastUserSnippet: "original prompt",
} as const;

const ownedMeta = {
  ...baseMeta,
  status: "error",
  browser: {
    ...baseMeta.browser,
    runtime: {
      ...baseMeta.browser?.runtime,
      chromeTargetId: "target-x",
      userDataDir: "/tmp/recover-profile",
      browserDisposition: "recoverable",
      recoveryKind: "draft-retained",
    },
  },
} as SessionMetadata;

describe("harvestSessionBrowserOutput recovery fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
      )
      .mockResolvedValueOnce(completedHarvest);

    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    const finish = vi.fn(async () => undefined);
    const recoverConversationTab = vi.fn(async (meta: SessionMetadata) => ({
      host: "127.0.0.1",
      port: 53999,
      url: meta.browser?.runtime?.tabUrl ?? "",
      ref: "saved-conversation",
      chrome: fakeChrome,
      finish,
    }));

    const readSession = vi.fn(async () => baseMeta);
    const updateExistingSession = vi.fn(
      async (_id: string, update: (meta: SessionMetadata) => SessionMetadata | null) =>
        update(baseMeta),
    );

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession,
        updateExistingSession,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      existingEndpoint: { host: "127.0.0.1", port: 9223 },
    });
    // After recovery, harvest is retried against the recovered endpoint/url.
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "saved-conversation",
      }),
    );
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
    expect(updateExistingSession).toHaveBeenCalled();
    // Default closeAfterRecover is false — Chrome stays alive for the user.
    expect(fakeChrome.kill).not.toHaveBeenCalled();
    expect(fakeChrome.process.unref).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith("completed", { ensureSentinel: true });
  });

  test("does not recover when recoverIfMissing is false; surfaces the original error", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched stuff"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => baseMeta,
        updateSession: async () => {},
        updateExistingSession: async (
          _id: string,
          update: (meta: SessionMetadata) => SessionMetadata | null,
        ) => update(baseMeta),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { recoverIfMissing: false, quietOutput: true }),
    ).rejects.toThrow(/No ChatGPT tab matched/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("recovers when the endpoint has no live ChatGPT tabs", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint."),
      )
      .mockResolvedValueOnce(completedHarvest);

    const finish = vi.fn(async () => undefined);
    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53998,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "saved-conversation",
      chrome: { kill: vi.fn() },
      finish,
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => baseMeta,
        updateSession: async () => {},
        updateExistingSession: async (
          _id: string,
          update: (meta: SessionMetadata) => SessionMetadata | null,
        ) => update(baseMeta),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledWith("completed", { ensureSentinel: true });
  });

  test("closes the recovered Chrome when closeAfterRecover is true", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
      .mockResolvedValueOnce(completedHarvest);
    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    const finish = vi.fn(async () => undefined);
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53777,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "saved-conversation",
        chrome: fakeChrome,
        finish,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => baseMeta,
        updateSession: async () => {},
        updateExistingSession: async (
          _id: string,
          update: (meta: SessionMetadata) => SessionMetadata | null,
        ) => update(baseMeta),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      closeAfterRecover: true,
      quietOutput: true,
    });
    expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
    expect(fakeChrome.process.unref).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("completed", { ensureSentinel: false });
  });

  test("does not recover an explicit browser tab override", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched explicit-ref"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => baseMeta,
        updateSession: async () => {},
        updateExistingSession: async (
          _id: string,
          update: (meta: SessionMetadata) => SessionMetadata | null,
        ) => update(baseMeta),
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-ref",
        quietOutput: true,
      }),
    ).rejects.toThrow(/explicit-ref/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("does not recreate a session deleted between initial read and completed harvest persistence", async () => {
    let current: SessionMetadata | null = ownedMeta;
    const harvestChatGptTab = vi.fn(async () => {
      current = null;
      return completedHarvest;
    });
    const readSession = vi.fn(async () => current);
    const updateSession = vi.fn(async (_id: string, updates: Partial<SessionMetadata>) => {
      current = { id: ownedMeta.id, ...updates } as SessionMetadata;
      return current;
    });
    const updateExistingSession = vi.fn(
      async (_id: string, update: (meta: SessionMetadata) => SessionMetadata | null) => {
        if (!current) return null;
        const next = update(current);
        if (next) current = next;
        return next;
      },
    );
    const reconcileOwnedBrowserTargets = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: () => true,
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/lifecycleReconciler.js", () => ({
      reconcileOwnedBrowserTargets,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession, updateExistingSession },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput(ownedMeta.id, { quietOutput: true });

    expect(current).toBeNull();
    expect(updateSession).not.toHaveBeenCalled();
    expect(reconcileOwnedBrowserTargets).not.toHaveBeenCalled();
  });

  test("does not let completed harvest persistence restore stale target ownership", async () => {
    const reassigned = {
      ...ownedMeta,
      browser: {
        ...ownedMeta.browser,
        runtime: { ...ownedMeta.browser?.runtime, chromeTargetId: "target-y" },
      },
    } as SessionMetadata;
    let current: SessionMetadata | null = ownedMeta;
    const harvestChatGptTab = vi.fn(async () => {
      current = reassigned;
      return completedHarvest;
    });
    const readSession = vi.fn(async () => current);
    const updateSession = vi.fn(async (_id: string, updates: Partial<SessionMetadata>) => {
      current = { ...current, ...updates } as SessionMetadata;
      return current;
    });
    const updateExistingSession = vi.fn(
      async (_id: string, update: (meta: SessionMetadata) => SessionMetadata | null) => {
        if (!current) return null;
        const next = update(current);
        if (next) current = next;
        return next;
      },
    );
    const reconcileOwnedBrowserTargets = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      isRecoveredConversationHarvestReady: () => true,
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/lifecycleReconciler.js", () => ({
      reconcileOwnedBrowserTargets,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession, updateExistingSession },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput(ownedMeta.id, { quietOutput: true });

    expect(current?.browser?.runtime?.chromeTargetId).toBe("target-y");
    expect(current?.browser?.harvest?.targetId).toBe("target-x");
    expect(updateSession).not.toHaveBeenCalled();
    expect(reconcileOwnedBrowserTargets).not.toHaveBeenCalled();
  });

  test.each([
    ["--harvest", "harvestSessionBrowserOutput"],
    ["--live", "liveTailSessionBrowserOutput"],
  ])(
    "blocks generic %s recovery for a Batch child before touching its tab",
    async (_flag, name) => {
      const batchMeta = {
        ...ownedMeta,
        batch: {
          batchId: "batch-123",
          laneId: "constitution",
          role: "lane",
          attempt: 1,
          inputManifestSha256: "a".repeat(64),
        },
      } as SessionMetadata;
      const harvestChatGptTab = vi.fn(async () => completedHarvest);
      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => "saved-conversation",
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        isRecoveredConversationHarvestReady: () => true,
        recoverConversationTab: vi.fn(),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: vi.fn(async () => batchMeta),
          updateSession: vi.fn(),
          updateExistingSession: vi.fn(),
        },
      }));

      const browserTabs = await import("../../src/cli/browserTabs.js");
      const run = browserTabs[name as "harvestSessionBrowserOutput"] as (
        id: string,
        options: { quietOutput?: boolean },
      ) => Promise<unknown>;
      await expect(run(batchMeta.id, { quietOutput: true })).rejects.toThrow(
        /batchId=batch-123, laneId=constitution, role=lane.*oracle batch resume batch-123/su,
      );
      expect(harvestChatGptTab).not.toHaveBeenCalled();
    },
  );
});
