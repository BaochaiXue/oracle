import { describe, expect, test, vi } from "vitest";
import { __test__, resolveSessionTabRefForTest } from "../../src/cli/browserTabs.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

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
    const updateSession = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => ({
      status: "complete" as const,
      closedTargetIds: ["owned-target"],
      targetSnapshots: { "owned-target": { url: "https://chatgpt.com/c/manual-send" } },
    }));

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        meta,
        harvested,
        { host: "127.0.0.1", port: 9333 },
        undefined,
        {
          readSession: readSession as never,
          updateSession: updateSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(true);

    expect(updateSession).toHaveBeenCalledWith(
      meta.id,
      expect.objectContaining({
        browser: expect.objectContaining({
          runtime: expect.objectContaining({
            browserDisposition: "completed",
            recoveryKind: undefined,
            recoveryExpiresAt: undefined,
          }),
        }),
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
    const updateSession = vi.fn();
    const reconcile = vi.fn();

    await expect(
      __test__.finishCompletedOwnedLiveHarvest(
        meta.id,
        meta,
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
          updateSession: updateSession as never,
          reconcile: reconcile as never,
        },
      ),
    ).resolves.toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
