import { describe, expect, test, vi } from "vitest";
import { createConversationUrlMonitor } from "../../src/browser/conversationUrlMonitor.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("createConversationUrlMonitor", () => {
  test("persists a conversation URL that appears after prompt submission", async () => {
    const readUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://chatgpt.com/")
      .mockResolvedValue("https://chatgpt.com/c/issue-284");
    const persistUrl = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl,
      logger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.schedule("post-submit", 1_000)).resolves.toBe(true);

    expect(persistUrl).toHaveBeenCalledWith("https://chatgpt.com/c/issue-284");
    expect(logger).toHaveBeenCalledWith(
      "[browser] conversation url (post-submit) = https://chatgpt.com/c/issue-284",
    );
  });

  test("ignores transient WEB request routes until the durable conversation URL appears", async () => {
    const readUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430")
      .mockResolvedValue("https://chatgpt.com/c/6a61036f-4cc4-83e8-8415-efb820f52db9");
    const persistUrl = vi.fn(async () => {});
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.update("assistant-wait", 1_000)).resolves.toBe(true);

    expect(readUrl).toHaveBeenCalledTimes(2);
    expect(persistUrl).toHaveBeenCalledOnce();
    expect(persistUrl).toHaveBeenCalledWith(
      "https://chatgpt.com/c/6a61036f-4cc4-83e8-8415-efb820f52db9",
    );
  });

  test("keeps polling through read errors until the URL appears", async () => {
    let reads = 0;
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: async () => {
        reads += 1;
        if (reads < 3) {
          throw new Error("evaluate failed");
        }
        return "https://chatgpt.com/c/recovered";
      },
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {},
      now: () => reads * 250,
    });

    await expect(monitor.update("assistant-wait", 5_000)).resolves.toBe(true);

    expect(reads).toBe(3);
    expect(persistUrl).toHaveBeenCalledWith("https://chatgpt.com/c/recovered");
  });

  test("shares one in-flight poll between background callers", async () => {
    let resolveRead: ((url: string) => void) | undefined;
    const readUrl = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl: async () => {},
      logger: vi.fn() as BrowserLogger,
    });

    const first = monitor.schedule("post-submit", 1_000);
    const second = monitor.schedule("assistant-wait", 1_000);
    expect(monitor.isInFlight()).toBe(true);
    expect(readUrl).toHaveBeenCalledTimes(1);

    resolveRead?.("https://chatgpt.com/c/shared");
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(monitor.isInFlight()).toBe(false);
  });

  test("stops a background poll when its browser run ends", async () => {
    const readUrl = vi.fn(async () => "https://chatgpt.com/");
    let monitor: ReturnType<typeof createConversationUrlMonitor>;
    monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl: async () => {},
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        await monitor.stop();
      },
    });

    await expect(monitor.schedule("post-submit", 120_000)).resolves.toBe(false);
    expect(readUrl).toHaveBeenCalledTimes(1);
  });

  test("does not persist a URL read after the monitor stops", async () => {
    let resolveRead: ((url: string) => void) | undefined;
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
      persistUrl,
      logger: vi.fn() as BrowserLogger,
    });

    const scheduled = monitor.schedule("post-submit", 1_000);
    await monitor.stop();
    resolveRead?.("https://chatgpt.com/c/late");

    await expect(scheduled).resolves.toBe(false);
    expect(persistUrl).not.toHaveBeenCalled();
  });

  test("waits for persistence already underway when stopping", async () => {
    let resolvePersist: (() => void) | undefined;
    const persistUrl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/c/persisting",
      persistUrl,
      logger: vi.fn() as BrowserLogger,
    });

    const scheduled = monitor.schedule("post-submit", 1_000);
    await vi.waitFor(() => expect(persistUrl).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePersist?.();
    await stopping;
    await expect(scheduled).resolves.toBe(true);
  });

  test("does not treat the ChatGPT root URL as a conversation", async () => {
    const persistUrl = vi.fn(async () => {});
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/",
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.update("assistant-timeout", 500)).resolves.toBe(false);

    expect(persistUrl).not.toHaveBeenCalled();
  });

  test("does not bind a durable URL until the committed prompt identity verifies", async () => {
    const validateCandidate = vi
      .fn<() => Promise<"pending" | "verified">>()
      .mockResolvedValueOnce("pending")
      .mockResolvedValue("verified");
    const persistUrl = vi.fn(async () => {});
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/c/committed-a",
      persistUrl,
      validateCandidate,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.update("post-submit", 1_000)).resolves.toBe(true);

    expect(validateCandidate).toHaveBeenCalledTimes(2);
    expect(monitor.boundConversationId()).toBe("committed-a");
    expect(persistUrl).toHaveBeenCalledOnce();
  });

  test("rejects the first durable URL when its user turn does not match the committed prompt", async () => {
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/c/unrelated-b",
      persistUrl,
      validateCandidate: async () => "mismatch",
      logger: vi.fn() as BrowserLogger,
    });

    await expect(monitor.update("post-submit", 1_000)).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "conversation-identity",
        code: "committed-prompt-mismatch",
        observedConversationId: "unrelated-b",
      },
    } satisfies Partial<BrowserAutomationError>);
    expect(persistUrl).not.toHaveBeenCalled();
    expect(() => monitor.assertHealthy()).toThrow(/different ChatGPT conversation/u);
  });

  test("does not let a transient WEB route hide a later unrelated durable conversation", async () => {
    const persistUrl = vi.fn(async () => {});
    let now = 0;
    const readUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://chatgpt.com/c/WEB:temporary-request")
      .mockResolvedValue("https://chatgpt.com/c/unrelated-b");
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl,
      validateCandidate: async () => "mismatch",
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.update("post-submit", 1_000)).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "conversation-identity",
        code: "committed-prompt-mismatch",
        observedConversationId: "unrelated-b",
      },
    } satisfies Partial<BrowserAutomationError>);
    expect(readUrl).toHaveBeenCalledTimes(2);
    expect(persistUrl).not.toHaveBeenCalled();
  });

  test("fails an active capture when the bound target navigates from conversation A to B", async () => {
    let currentUrl = "https://chatgpt.com/c/conversation-a";
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: async () => currentUrl,
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      watchAfterBind: true,
      pollIntervalMs: 1,
    });

    await expect(monitor.update("post-submit", 1_000)).resolves.toBe(true);
    const guarded = monitor.guard(() => new Promise<never>(() => {}));
    currentUrl = "https://chatgpt.com/c/conversation-b";

    await expect(guarded).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "conversation-identity",
        code: "conversation-id-mismatch",
        expectedConversationId: "conversation-a",
        observedConversationId: "conversation-b",
      },
    } satisfies Partial<BrowserAutomationError>);
    expect(monitor.boundConversationId()).toBe("conversation-a");
    expect(monitor.boundConversationUrl()).toBe("https://chatgpt.com/c/conversation-a");
    expect(persistUrl).toHaveBeenCalledOnce();
    await monitor.stop();
  });
});

describe("conversation url monitor snapshot", () => {
  test("records observed urls, candidate status, and read errors for diagnostics", async () => {
    const readUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("Target closed"))
      .mockResolvedValueOnce("https://chatgpt.com/")
      .mockResolvedValue("https://chatgpt.com/c/11111111-2222-4333-8444-555555555555");
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl: async () => undefined,
      logger: () => undefined,
      validateCandidate: async () => "pending",
      pollIntervalMs: 0,
      wait: async () => undefined,
    });
    await monitor.update("test", 5);
    const snapshot = monitor.snapshot();
    expect(snapshot.readErrorCount).toBe(1);
    expect(snapshot.lastReadError).toBe("Target closed");
    expect(snapshot.lastObservedUrl).toBe(
      "https://chatgpt.com/c/11111111-2222-4333-8444-555555555555",
    );
    expect(snapshot.lastCandidateStatus).toBe("pending");
    expect(snapshot.boundConversationId).toBeNull();
  });
});
