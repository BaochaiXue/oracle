import { describe, expect, test, vi } from "vitest";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import { hashProPromptIdentity } from "../../src/browser/proResponseTiming.js";

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const waitForConversationHydration = vi.fn(async () => 2);
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
    expect(waitForConversationHydration).toHaveBeenCalledWith(expect.anything(), 2000, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: runtime.tabUrl,
    });
    expect(waitForConversationHydration.mock.invocationCallOrder[0]).toBeLessThan(
      waitForAssistantResponse.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("accepts a persisted sub-minute Pro response without reopening the conversation", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/fast-pro",
      proDispatchAt: "2026-08-13T00:00:00.000Z",
      proResponseElapsedMs: 12_000,
      proInputTokens: 83,
      proAttachmentBytes: 0,
      proTurnIndex: 0,
      proTurnCommitted: true,
      proPromptSha256: hashProPromptIdentity("tiny committed prompt"),
      proCommittedTurnIndex: 0,
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: runtime.tabUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("expectedTurns")) return { result: { value: true } };
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "fast answer",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        runtime,
        { timeoutMs: 2_000, thinkingTime: "pro", modelStrategy: "select" },
        logger,
        {
          listTargets,
          connect,
          recoverSession,
          waitForAssistantResponse,
          captureAssistantMarkdown: vi.fn(async () => "fast answer"),
          waitForConversationHydration: vi.fn(async () => 2),
        },
      ),
    ).resolves.toMatchObject({
      answerText: "fast answer",
      answerMarkdown: "fast answer",
      runtime: expect.objectContaining({
        proResponseElapsedMs: 12_000,
        proInputTokens: 83,
        proResponseTimingReceipts: [
          expect.objectContaining({
            turnIndex: 0,
            responseElapsedMs: 12_000,
            inputTokens: 83,
            attachmentBytes: 0,
          }),
        ],
      }),
    });
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2_000, logger, 0);
  });

  test("refuses a legacy uncommitted follow-up instead of harvesting the prior answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/uncommitted-follow-up",
      proDispatchAt: "2026-08-13T00:01:00.000Z",
      proInputTokens: 4_096,
      proAttachmentBytes: 0,
      proTurnIndex: 1,
      proTurnCommitted: false,
      proPromptSha256: hashProPromptIdentity("follow-up that never committed"),
      proResponseTimingReceipts: [
        {
          turnIndex: 0,
          dispatchAt: "2026-08-13T00:00:00.000Z",
          responseElapsedMs: 90_000,
          inputTokens: 8,
          attachmentBytes: 0,
        },
      ],
    };
    const close = vi.fn(async () => {});
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "prior answer",
      html: "",
      meta: { messageId: "m0", turnId: "conversation-turn-0" },
    }));
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
        listTargets: async () => [{ targetId: "target-1", type: "page", url: runtime.tabUrl }],
        connect: async () =>
          ({
            Runtime: {
              enable: vi.fn(),
              evaluate: vi.fn(async ({ expression }: { expression: string }) => {
                if (expression === "location.href") return { result: { value: runtime.tabUrl } };
                if (expression === "1+1") return { result: { value: 2 } };
                return { result: { value: null } };
              }),
            },
            DOM: { enable: vi.fn() },
            close,
          }) as unknown as ChromeClient,
        recoverSession,
        waitForAssistantResponse,
        captureAssistantMarkdown: vi.fn(async () => "prior answer"),
        waitForConversationHydration: vi.fn(async () => 2),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "pro-turn-not-committed" }),
    });
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("reconciles an indeterminate Pro follow-up by exact digest before capturing", async () => {
    const followUp = "current follow-up that committed late";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/late-follow-up",
      recoveryKind: "awaiting-response" as const,
      browserPromptSha256: hashProPromptIdentity(followUp),
      browserPromptBaselineTurns: 2,
      proDispatchAt: "2026-08-13T00:01:00.000Z",
      proInputTokens: 4_096,
      proAttachmentBytes: 0,
      proTurnIndex: 1,
      proTurnCommitted: false,
      proPromptSha256: hashProPromptIdentity(followUp),
      proResponseTimingReceipts: [
        {
          turnIndex: 0,
          dispatchAt: "2026-08-13T00:00:00.000Z",
          responseElapsedMs: 90_000,
          inputTokens: 8,
          attachmentBytes: 0,
        },
      ],
    };
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: runtime.tabUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("BASELINE_TURNS")) return { result: { value: [2] } };
      if (expression.includes("expectedTurns")) return { result: { value: true } };
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const persistRuntime = vi.fn(async () => {});
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "new follow-up answer",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-3" },
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
      listTargets: async () => [{ targetId: "target-1", type: "page", url: runtime.tabUrl }],
      connect: async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) as unknown as ChromeClient,
      waitForAssistantResponse,
      captureAssistantMarkdown: vi.fn(async () => "new follow-up answer"),
      waitForConversationHydration: vi.fn(async () => 4),
      promptPreview: "the original session prompt",
      persistRuntime,
    });

    expect(result.answerMarkdown).toBe("new follow-up answer");
    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2_000, logger, 2);
    expect(persistRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPromptCommittedTurnIndex: 2,
        proTurnCommitted: true,
        proCommittedTurnIndex: 2,
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test("does not fall back to another tab when an indeterminate commit target is gone", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/ambiguous-follow-up",
      browserDisposition: "recoverable" as const,
      recoveryKind: "awaiting-response" as const,
      promptSubmitted: false,
      browserPromptSha256: hashProPromptIdentity("ambiguous follow-up"),
      browserPromptBaselineTurns: 2,
    };
    const connect = vi.fn();
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, vi.fn() as BrowserLogger, {
        listTargets: async () => [
          {
            targetId: "target-2",
            type: "page",
            url: "https://chatgpt.com/c/ambiguous-follow-up",
          },
        ],
        connect,
        recoverSession,
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "browser-exact-target-unavailable",
        recoverable: true,
        retrySafe: false,
      }),
    });
    expect(connect).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("reattaches a manual-intervention target without capturing an earlier answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/",
      browserDisposition: "recoverable" as const,
      recoveryKind: "manual-intervention" as const,
      promptSubmitted: false,
    };
    const close = vi.fn(async () => {});
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "prior answer",
      html: "",
      meta: { messageId: "m0", turnId: "conversation-turn-0" },
    }));

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, vi.fn() as BrowserLogger, {
        listTargets: async () => [{ targetId: "target-1", type: "page", url: runtime.tabUrl }],
        connect: async () =>
          ({
            Runtime: {
              enable: vi.fn(),
              evaluate: vi.fn(async ({ expression }: { expression: string }) => {
                if (expression === "location.href") return { result: { value: runtime.tabUrl } };
                if (expression === "1+1") return { result: { value: 2 } };
                return { result: { value: null } };
              }),
            },
            DOM: { enable: vi.fn() },
            close,
          }) as unknown as ChromeClient,
        waitForAssistantResponse,
        waitForConversationHydration: vi.fn(async () => 1),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "browser-manual-intervention-required",
        recoverable: true,
        retrySafe: false,
      }),
    });
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("fails closed when a current prompt digest has no recovery boundary", async () => {
    const evaluate = vi.fn(async () => ({ result: { value: [0] } }));
    const Runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(
      __test__.reconcileBrowserPromptIdentity(Runtime, {
        browserPromptSha256: hashProPromptIdentity("current follow-up"),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "browser-prompt-baseline-missing",
        recoverable: true,
        retrySafe: false,
      }),
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("rejects new-format turn markers when the commit flag is absent", async () => {
    const evaluate = vi.fn(async () => ({ result: { value: null } }));

    await expect(
      __test__.verifyCommittedProTurnIdentity({ evaluate } as unknown as ChromeClient["Runtime"], {
        proTurnIndex: 0,
        proDispatchAt: "2026-08-13T00:00:00.000Z",
        proResponseElapsedMs: 90_000,
        proInputTokens: 4_096,
        proAttachmentBytes: 0,
      }),
    ).rejects.toMatchObject({ details: { code: "pro-turn-not-committed" } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("rejects recovery when the committed browser turn no longer matches the prompt digest", async () => {
    const runtime = {
      proTurnIndex: 0,
      proTurnCommitted: true,
      proCommittedTurnIndex: 4,
      proPromptSha256: hashProPromptIdentity("expected follow-up"),
    };
    const Runtime = {
      evaluate: vi.fn(async () => ({ result: { value: false } })),
    } as unknown as ChromeClient["Runtime"];

    await expect(__test__.verifyCommittedProTurnIdentity(Runtime, runtime)).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "pro-turn-identity-mismatch",
        committedTurnIndex: 4,
      }),
    });
  });

  test.each([
    {
      label: "prompt digest",
      historicalPromptSha256: "b".repeat(64),
      historicalCommittedUserTurnIndex: 0,
      expectedDetails: { verifiedReceiptTurnIndices: [0, 1] },
      expectsDomEvaluation: true,
    },
    {
      label: "committed DOM index",
      historicalPromptSha256: hashProPromptIdentity("initial prompt"),
      historicalCommittedUserTurnIndex: 4,
      expectedDetails: {
        receiptTurnIndex: 1,
        committedUserTurnIndex: 2,
        previousCommittedUserTurnIndex: 4,
      },
      expectsDomEvaluation: false,
    },
  ])(
    "fails closed when an older self-contained receipt has another valid $label",
    async ({
      historicalPromptSha256,
      historicalCommittedUserTurnIndex,
      expectedDetails,
      expectsDomEvaluation,
    }) => {
      const currentPromptSha256 = hashProPromptIdentity("current follow-up");
      const runtime = {
        proDispatchAt: "2026-08-13T00:02:00.000Z",
        proResponseElapsedMs: 90_000,
        proInputTokens: 4_000,
        proAttachmentBytes: 0,
        proTurnIndex: 1,
        proTurnCommitted: true,
        proPromptSha256: currentPromptSha256,
        proCommittedTurnIndex: 2,
        proResponseTimingProvenance: "verified" as const,
        proResponseTimingReceipts: [
          {
            turnIndex: 0,
            dispatchAt: "2026-08-13T00:00:00.000Z",
            responseElapsedMs: 90_000,
            inputTokens: 8,
            attachmentBytes: 0,
            promptSha256: historicalPromptSha256,
            committedUserTurnIndex: historicalCommittedUserTurnIndex,
            commitVerification: "verified" as const,
          },
          {
            turnIndex: 1,
            dispatchAt: "2026-08-13T00:02:00.000Z",
            responseElapsedMs: 90_000,
            inputTokens: 4_000,
            attachmentBytes: 0,
            promptSha256: currentPromptSha256,
            committedUserTurnIndex: 2,
            commitVerification: "verified" as const,
          },
        ],
      };
      const Runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          expect(expression).toContain(historicalPromptSha256);
          expect(expression).toContain(
            `"committedUserTurnIndex":${historicalCommittedUserTurnIndex}`,
          );
          expect(expression).toContain(currentPromptSha256);
          return { result: { value: false } };
        }),
      } as unknown as ChromeClient["Runtime"];

      await expect(__test__.verifyCommittedProTurnIdentity(Runtime, runtime)).rejects.toMatchObject(
        {
          details: expect.objectContaining({
            code: "pro-turn-identity-mismatch",
            ...expectedDetails,
          }),
        },
      );
      if (expectsDomEvaluation) {
        expect(Runtime.evaluate).toHaveBeenCalledOnce();
      } else {
        expect(Runtime.evaluate).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    { label: "reversed", committedUserTurnIndices: [4, 2] },
    { label: "duplicate", committedUserTurnIndices: [2, 2] },
  ])(
    "rejects $label historical DOM indices before accepting matching DOM prompt hashes",
    async ({ committedUserTurnIndices }) => {
      const promptSha256 = [
        hashProPromptIdentity("initial prompt"),
        hashProPromptIdentity("current follow-up"),
      ];
      const runtime = {
        proDispatchAt: "2026-08-13T00:01:00.000Z",
        proResponseElapsedMs: 90_000,
        proInputTokens: 4_000,
        proAttachmentBytes: 0,
        proTurnIndex: 1,
        proTurnCommitted: true,
        proPromptSha256: promptSha256[1],
        proCommittedTurnIndex: committedUserTurnIndices[1],
        proResponseTimingProvenance: "verified" as const,
        proResponseTimingReceipts: committedUserTurnIndices.map(
          (committedUserTurnIndex, turnIndex) => ({
            turnIndex,
            dispatchAt: `2026-08-13T00:0${turnIndex}:00.000Z`,
            responseElapsedMs: 90_000,
            inputTokens: turnIndex === 0 ? 8 : 4_000,
            attachmentBytes: 0,
            promptSha256: promptSha256[turnIndex],
            committedUserTurnIndex,
            commitVerification: "verified" as const,
          }),
        ),
      };
      const Runtime = {
        evaluate: vi.fn(async () => ({ result: { value: true } })),
      } as unknown as ChromeClient["Runtime"];

      await expect(__test__.verifyCommittedProTurnIdentity(Runtime, runtime)).rejects.toMatchObject(
        {
          details: expect.objectContaining({ code: "pro-turn-identity-mismatch" }),
        },
      );
      expect(Runtime.evaluate).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      label: "persisted substantive workload",
      workload: { proInputTokens: 4_096, proAttachmentBytes: 0 },
      expectedDetails: { inputTokens: 4_096 },
    },
    {
      label: "legacy workload-unknown receipt",
      workload: {},
      expectedDetails: { workloadMetadata: "unknown" },
    },
  ])("keeps a fast $label rejected on reattach", async ({ workload, expectedDetails }) => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/fast-substantive-pro",
      proDispatchAt: "2026-08-13T00:00:00.000Z",
      proResponseElapsedMs: 19_000,
      ...workload,
    };
    const close = vi.fn(async () => {});
    const recoverSession = vi.fn(async () => ({
      answerText: "must not recover",
      answerMarkdown: "must not recover",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        runtime,
        { timeoutMs: 2_000, thinkingTime: "pro", modelStrategy: "select" },
        logger,
        {
          listTargets: async () => [{ targetId: "target-1", type: "page", url: runtime.tabUrl }],
          connect: async () =>
            ({
              Runtime: {
                enable: vi.fn(),
                evaluate: vi.fn(async ({ expression }: { expression: string }) => {
                  if (expression === "location.href") {
                    return { result: { value: runtime.tabUrl } };
                  }
                  if (expression === "1+1") return { result: { value: 2 } };
                  return { result: { value: null } };
                }),
              },
              DOM: { enable: vi.fn() },
              close,
            }) as unknown as ChromeClient,
          recoverSession,
          waitForAssistantResponse: vi.fn(async () => ({
            text: "implausibly fast engineering review",
            html: "",
            meta: { messageId: "m1", turnId: "conversation-turn-1" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "implausibly fast engineering review"),
          waitForConversationHydration: vi.fn(async () => 2),
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "pro-fast-substantive-response-untrusted",
        responseElapsedMs: 19_000,
        ...expectedDetails,
      }),
    });
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("uses prompt preview turn index when reattaching to an already-open answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("const needle =")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      waitForConversationHydration: vi.fn(async () => 2),
      promptPreview: "live reattach pro 123",
    });

    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2000, logger, 3);
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      {
        requireScopedTargetOwner: true,
      },
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForConversationHydration: vi.fn(async () => 2),
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "must not be captured from an unhydrated shell",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const waitForConversationHydration = vi.fn(async () => {
      throw new Error("saved conversation did not hydrate");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      waitForConversationHydration,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("pickTarget prefers a saved conversation over a stale target id", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "page-1" })).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
