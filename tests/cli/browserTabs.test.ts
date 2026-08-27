import { describe, expect, test, vi } from "vitest";
import { __test__, resolveSessionTabRefForTest } from "../../src/cli/browserTabs.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function manualSendMeta(): SessionMetadata {
  return {
    id: "manual-send-session",
    createdAt: "2026-08-26T00:00:00.000Z",
    status: "error",
    options: {},
    mode: "browser",
    browser: {
      runtime: {
        chromeHost: "127.0.0.1",
        chromePort: 9333,
        chromeTargetId: "owned-target",
        userDataDir: "/oracle/profile",
        tabUrl: "https://chatgpt.com/c/manual-send",
        conversationId: "manual-send",
        promptSubmitted: false,
        browserDisposition: "recoverable",
        recoveryKind: "draft-retained",
      },
    },
  } as SessionMetadata;
}

function completedManualHarvest(overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary {
  return {
    targetId: "owned-target",
    url: "https://chatgpt.com/c/manual-send",
    conversationId: "manual-send",
    state: "completed",
    assistantCount: 1,
    assistantFollowsLatestUser: true,
    lastAssistantText: "completed answer",
    lastUserTurnIndex: 0,
    lastAssistantTurnIndex: 1,
    ...overrides,
  } as ChatGptTabSummary;
}

describe("browser tab CLI helpers", () => {
  test("prefers stable conversation URLs over stale Chrome target ids", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "stale-target",
          tabUrl: "https://chatgpt.com/c/runtime-conversation",
          conversationId: "runtime-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("https://chatgpt.com/c/runtime-conversation");
  });

  test("terminalizes and reconciles the exact session-owned tab after a completed manual harvest", async () => {
    const meta = {
      id: "manual-send-session",
      createdAt: "2026-08-26T00:00:00.000Z",
      status: "error",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9333,
          chromeTargetId: "owned-target",
          userDataDir: "/oracle/profile",
          tabUrl: "https://chatgpt.com/c/manual-send",
          conversationId: "manual-send",
          promptSubmitted: false,
          browserDisposition: "recoverable",
          recoveryKind: "draft-retained",
        },
      },
    } as SessionMetadata;
    const harvested = {
      targetId: "owned-target",
      url: "https://chatgpt.com/c/manual-send",
      conversationId: "manual-send",
      state: "completed",
      assistantCount: 1,
      assistantFollowsLatestUser: true,
      lastAssistantText: "completed answer",
      lastUserTurnIndex: 0,
      lastAssistantTurnIndex: 1,
    } as ChatGptTabSummary;
    const readSession = vi.fn(async () => meta);
    let current = meta;
    const updateExistingSession = vi.fn(
      async (_id: string, update: (value: SessionMetadata) => SessionMetadata | null) => {
        const next = update(current);
        if (next) current = next;
        return next;
      },
    );
    const reconcile = vi.fn(async () => ({
      status: "complete" as const,
      closedTargetIds: ["owned-target"],
      targetSnapshots: { "owned-target": { url: "https://chatgpt.com/c/manual-send" } },
    }));

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        harvested,
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(true);

    expect(updateExistingSession).toHaveBeenCalledTimes(1);
    expect(current.browser?.runtime).toEqual(
      expect.objectContaining({
        browserDisposition: "completed",
        recoveryKind: undefined,
        recoveryExpiresAt: undefined,
      }),
    );
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileDir: "/oracle/profile",
        host: "127.0.0.1",
        port: 9333,
        ensureSentinel: true,
      }),
    );
  });

  test("does not close a target whose action-time session ownership changed", async () => {
    const meta = {
      id: "manual-send-session",
      createdAt: "2026-08-26T00:00:00.000Z",
      status: "error",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9333,
          chromeTargetId: "owned-target",
          userDataDir: "/oracle/profile",
        },
      },
    } as SessionMetadata;
    const current = {
      ...meta,
      browser: {
        ...meta.browser,
        runtime: {
          ...meta.browser?.runtime,
          chromeTargetId: "reassigned-target",
        },
      },
    } as SessionMetadata;
    const readSession = vi.fn(async () => current);
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        {
          targetId: "owned-target",
          url: "https://chatgpt.com/c/manual-send",
          state: "completed",
          assistantCount: 1,
          assistantFollowsLatestUser: true,
          lastAssistantText: "completed answer",
          lastUserTurnIndex: 0,
          lastAssistantTurnIndex: 1,
        } as ChatGptTabSummary,
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("does not recreate a session missing at the action-time ownership read", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn(async () => null);
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest(),
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("preserves a stable-conversation session when the harvested conversation id is missing", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn(async () => meta);
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest({ conversationId: undefined, url: "https://chatgpt.com/" }),
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("preserves a stable-conversation session when the harvested conversation id differs", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn(async () => meta);
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest({
          conversationId: "another-conversation",
          url: "https://chatgpt.com/c/another-conversation",
        }),
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("preserves the tab when an explicit browser tab override was used", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn();
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest(),
        { host: "127.0.0.1", port: 9333 },
        "owned-target",
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(readSession).not.toHaveBeenCalled();
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("preserves the tab when the action-time endpoint does not match", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn(async () => meta);
    const updateExistingSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest(),
        { host: "127.0.0.1", port: 9444 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("marks reconciliation work when exact-target cleanup fails and the session still exists", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn(async () => meta);
    let current = meta;
    const updateExistingSession = vi.fn(
      async (_id: string, update: (value: SessionMetadata) => SessionMetadata | null) => {
        const next = update(current);
        if (next) current = next;
        return next;
      },
    );
    const reconcile = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest(),
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).toHaveBeenCalledTimes(2);
    expect(current.browser?.runtime).toEqual(
      expect.objectContaining({
        browserDisposition: "completed",
        reconcileNeeded: true,
      }),
    );
  });

  test("does not recreate a session deleted after reconciliation failure", async () => {
    const meta = manualSendMeta();
    const readSession = vi.fn().mockResolvedValueOnce(meta).mockResolvedValueOnce(null);
    const updateExistingSession = vi.fn(
      async (_id: string, update: (value: SessionMetadata) => SessionMetadata | null) =>
        update(meta),
    );
    const reconcile = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        completedManualHarvest(),
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateExistingSession: updateExistingSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateExistingSession).toHaveBeenCalledTimes(1);
  });
});
