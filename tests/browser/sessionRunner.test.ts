import { describe, expect, test, vi } from "vitest";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  buildBrowserRunWarningsForTest,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.js";

const baseRunOptions: RunOracleOptions = {
  prompt: "Hello world",
  model: "gpt-5.2-pro",
  file: [],
  silent: false,
};

const baseConfig: BrowserSessionConfig = {};

describe("runBrowserSessionExecution", () => {
  test("logs stats and returns usage/runtime", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.(
        {
          chromePort: 9999,
          chromeHost: "127.0.0.1",
          chromeTargetId: "t-1",
          tabUrl: "https://chatgpt.com/c/foo",
          conversationId: "foo",
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        artifacts: [{ kind: "transcript" as const, path: "/tmp/transcript.md" }],
        tookMs: 1000,
        answerTokens: 12,
        answerChars: 20,
        conversationId: "foo",
        proDispatchAt: "2026-08-15T00:00:00.000Z",
        proResponseElapsedMs: 18_854,
      };
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 12,
      reasoningTokens: 0,
      totalTokens: 54,
    });
    expect(result.runtime).toMatchObject({
      chromePid: undefined,
      conversationId: "foo",
      proResponseElapsedMs: 18_854,
      proInputTokens: 42,
      proAttachmentBytes: 0,
    });
    expect(result.artifacts).toEqual([{ kind: "transcript", path: "/tmp/transcript.md" }]);
    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        chromePort: 9999,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        proInputTokens: 42,
        proAttachmentBytes: 0,
      }),
      expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
    );
    expect(log).toHaveBeenCalled();
  });

  test("passes browser resume conversation URL to executeBrowser", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 1000,
      answerTokens: 12,
      answerChars: 20,
    }));

    await runBrowserSessionExecution(
      {
        runOptions: {
          ...baseRunOptions,
          browserResumeConversationUrl: "https://chatgpt.com/c/resume-me",
        },
        browserConfig: {},
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          resumeConversationUrl: "https://chatgpt.com/c/resume-me",
        }),
      }),
    );
  });

  test("logs and returns browser model selection evidence", async () => {
    const log = vi.fn();
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: { desiredModel: "GPT-5.5 Pro", modelStrategy: "select" },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: vi.fn(async () => ({
          answerText: "ok",
          answerMarkdown: "ok",
          tookMs: 1000,
          answerTokens: 12,
          answerChars: 20,
          modelSelection: {
            requestedModel: "GPT-5.5 Pro",
            resolvedLabel: "Pro",
            strategy: "select" as const,
            status: "already-selected" as const,
            verified: true,
            source: "chatgpt-model-picker" as const,
            capturedAt: "2026-05-13T00:00:00.000Z",
          },
        })),
      },
    );

    expect(result.modelSelection).toMatchObject({
      requestedModel: "GPT-5.5 Pro",
      resolvedLabel: "Pro",
      verified: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Launching browser mode (target=GPT-5.5 Pro; requested=gpt-5.2-pro)"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "[browser] Model selection evidence: requestedKey=gpt-5.2-pro; target=GPT-5.5 Pro; resolvedLabel=Pro",
      ),
    );
  });

  test("prints model-picker diagnostics without verbose mode", async () => {
    const log = vi.fn();

    await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: vi.fn(async ({ log: browserLog }) => {
          browserLog('[browser] Model picker diagnostic: {"targetLevel":"extended"}');
          return {
            answerText: "ok",
            answerMarkdown: "ok",
            tookMs: 1000,
            answerTokens: 1,
            answerChars: 2,
          };
        }),
      },
    );

    expect(log).toHaveBeenCalledWith(
      '[browser] Model picker diagnostic: {"targetLevel":"extended"}',
    );
  });

  test("warns when a large browser Pro run finishes suspiciously quickly", () => {
    const warnings = buildBrowserRunWarningsForTest({
      runOptions: { ...baseRunOptions, model: "gpt-5.5-pro" },
      browserConfig: { desiredModel: "GPT-5.5 Pro" },
      inputTokens: 42_641,
      elapsedMs: 53_000,
      modelSelection: {
        requestedModel: "GPT-5.5 Pro",
        resolvedLabel: null,
        strategy: "select",
        status: "unavailable",
        verified: false,
        source: "config",
        capturedAt: "2026-05-13T00:00:00.000Z",
      },
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: "browser-pro-fast-large-run",
        message: expect.stringContaining("Large browser Pro run completed quickly"),
      }),
    ]);
  });

  test("rejects a fast substantive Pro result before surfacing the answer", async () => {
    const log = vi.fn();

    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { ...baseRunOptions, model: "gpt-5-pro" },
          browserConfig: { desiredModel: "GPT-5.6 Pro", thinkingTime: "pro" },
          cwd: "/repo",
          log,
        },
        {
          assemblePrompt: async () => ({
            markdown: "substantive prompt",
            composerText: "substantive prompt",
            estimatedInputTokens: 4_096,
            attachments: [],
            inlineFileCount: 1,
            tokenEstimateIncludesInlineFiles: true,
            attachmentsPolicy: "never",
            attachmentMode: "inline",
            fallback: null,
          }),
          executeBrowser: vi.fn(async () => ({
            answerText: "private engineering review",
            answerMarkdown: "private engineering review",
            tookMs: 19_000,
            answerTokens: 3,
            answerChars: 26,
            promptSubmitted: true,
            proDispatchAt: "2026-08-15T00:00:00.000Z",
            proResponseElapsedMs: 19_000,
          })),
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "pro-fast-substantive-response-untrusted",
        inputTokens: 4_096,
        responseElapsedMs: 19_000,
      }),
    });

    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "private engineering review",
    );
  });

  test("rejects partial turn receipts even when the resolved config is not Pro", async () => {
    const log = vi.fn();

    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { ...baseRunOptions, model: "gpt-5.1" },
          browserConfig: { thinkingTime: "standard" },
          cwd: "/repo",
          log,
        },
        {
          assemblePrompt: async () => ({
            markdown: "prompt",
            composerText: "prompt",
            estimatedInputTokens: 20,
            attachments: [],
            inlineFileCount: 0,
            tokenEstimateIncludesInlineFiles: false,
            attachmentsPolicy: "auto",
            attachmentMode: "inline",
            fallback: null,
          }),
          executeBrowser: vi.fn(async () => ({
            answerText: "partial",
            answerMarkdown: "partial",
            tookMs: 90_000,
            answerTokens: 1,
            answerChars: 7,
            proTurnIndex: 0,
            proDispatchAt: "2026-08-15T00:00:00.000Z",
            proResponseElapsedMs: 90_000,
            proInputTokens: 20,
            proAttachmentBytes: 0,
          })),
        },
      ),
    ).rejects.toMatchObject({ details: { code: "pro-turn-not-committed" } });
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("partial");
  });

  test("adds the Pro workload receipt to browser errors with recoverable runtime", async () => {
    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { ...baseRunOptions, model: "gpt-5-pro" },
          browserConfig: { desiredModel: "GPT-5.6 Pro", thinkingTime: "pro" },
          cwd: "/repo",
          log: vi.fn(),
        },
        {
          assemblePrompt: async () => ({
            markdown: "prompt",
            composerText: "prompt",
            estimatedInputTokens: 4_096,
            attachments: [{ path: "/repo/input.bin", displayPath: "input.bin", sizeBytes: 20_000 }],
            inlineFileCount: 0,
            tokenEstimateIncludesInlineFiles: false,
            attachmentsPolicy: "always",
            attachmentMode: "upload",
            fallback: null,
          }),
          executeBrowser: vi.fn(async () => {
            throw new BrowserAutomationError("assistant timed out", {
              stage: "assistant-timeout",
              runtime: {
                tabUrl: "https://chatgpt.com/c/recoverable",
                promptSubmitted: true,
                proDispatchAt: "2026-08-15T00:00:00.000Z",
              },
            });
          }),
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        runtime: expect.objectContaining({
          proInputTokens: 4_096,
          proAttachmentBytes: 20_000,
        }),
      }),
    });
  });

  test("passes ChatGPT image output paths into the browser runner", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      artifacts: [{ kind: "transcript" as const, path: "/tmp/transcript.md" }],
      tookMs: 1000,
      answerTokens: 1,
      answerChars: 2,
    }));

    await runBrowserSessionExecution(
      {
        runOptions: {
          ...baseRunOptions,
          sessionId: "image-session",
          generateImage: "/tmp/generated.png",
          outputPath: "/tmp/output.png",
        },
        browserConfig: baseConfig,
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "image-session",
        generateImagePath: "/tmp/generated.png",
        outputPath: "/tmp/output.png",
      }),
    );
  });

  test("passes browser follow-up prompts into the browser runner", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 1000,
      answerTokens: 1,
      answerChars: 2,
    }));

    await runBrowserSessionExecution(
      {
        runOptions: {
          ...baseRunOptions,
          browserFollowUps: ["challenge the recommendation", "summarize the final decision"],
        },
        browserConfig: baseConfig,
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpPrompts: ["challenge the recommendation", "summarize the final decision"],
      }),
    );
  });

  test("uses the active follow-up workload receipt instead of the initial workload", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();

    await expect(
      runBrowserSessionExecution(
        {
          runOptions: {
            ...baseRunOptions,
            model: "gpt-5-pro",
            browserFollowUps: ["substantive follow-up"],
          },
          browserConfig: { desiredModel: "GPT-5.6 Pro", thinkingTime: "pro" },
          cwd: "/repo",
          log,
        },
        {
          assemblePrompt: async () => ({
            markdown: "hi",
            composerText: "hi",
            estimatedInputTokens: 2,
            attachments: [],
            inlineFileCount: 0,
            tokenEstimateIncludesInlineFiles: false,
            attachmentsPolicy: "auto",
            attachmentMode: "inline",
            fallback: null,
          }),
          executeBrowser: vi.fn(async (options) => {
            await options.runtimeHintCb?.({
              promptSubmitted: true,
              proTurnIndex: 1,
              proDispatchAt: "2026-08-15T00:01:00.000Z",
              proResponseElapsedMs: 20_000,
              proInputTokens: 5_000,
              proAttachmentBytes: 0,
              proTurnCommitted: true,
              proPromptSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              proCommittedTurnIndex: 2,
              proResponseTimingReceipts: [
                {
                  turnIndex: 0,
                  dispatchAt: "2026-08-15T00:00:00.000Z",
                  responseElapsedMs: 10_000,
                  inputTokens: 2,
                  attachmentBytes: 0,
                  promptSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  committedUserTurnIndex: 0,
                  commitVerification: "verified",
                },
              ],
              proResponseTimingProvenance: "verified",
            });
            return {
              answerText: "private multi-turn transcript",
              answerMarkdown: "private multi-turn transcript",
              tookMs: 30_000,
              answerTokens: 4,
              answerChars: 29,
              promptSubmitted: true,
              proTurnIndex: 1,
              proDispatchAt: "2026-08-15T00:01:00.000Z",
              proResponseElapsedMs: 20_000,
              proInputTokens: 5_000,
              proAttachmentBytes: 0,
              proTurnCommitted: true,
              proPromptSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              proCommittedTurnIndex: 2,
              proResponseTimingReceipts: [
                {
                  turnIndex: 0,
                  dispatchAt: "2026-08-15T00:00:00.000Z",
                  responseElapsedMs: 10_000,
                  inputTokens: 2,
                  attachmentBytes: 0,
                  promptSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  committedUserTurnIndex: 0,
                  commitVerification: "verified" as const,
                },
              ],
              proResponseTimingProvenance: "verified" as const,
            };
          }),
          persistRuntimeHint,
        },
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "pro-fast-substantive-response-untrusted",
        inputTokens: 5_000,
        responseElapsedMs: 20_000,
      }),
    });

    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        proTurnIndex: 1,
        proInputTokens: 5_000,
        proAttachmentBytes: 0,
      }),
    );
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "private multi-turn transcript",
    );
  });

  test.each([
    { label: "both active workload fields missing", activeWorkload: {} },
    { label: "active attachment bytes missing", activeWorkload: { proInputTokens: 5_000 } },
    { label: "active token estimate missing", activeWorkload: { proAttachmentBytes: 0 } },
  ])(
    "does not launder a follow-up through the tiny initial workload when $label",
    async ({ activeWorkload }) => {
      const log = vi.fn();
      const persistRuntimeHint = vi.fn();
      const activeRuntime = {
        promptSubmitted: true,
        proTurnIndex: 1,
        proTurnCommitted: true,
        proPromptSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        proCommittedTurnIndex: 2,
        proDispatchAt: "2026-08-15T00:01:00.000Z",
        proResponseElapsedMs: 20_000,
        proResponseTimingReceipts: [
          {
            turnIndex: 0,
            dispatchAt: "2026-08-15T00:00:00.000Z",
            responseElapsedMs: 10_000,
            inputTokens: 2,
            attachmentBytes: 0,
          },
        ],
        ...activeWorkload,
      };

      await expect(
        runBrowserSessionExecution(
          {
            runOptions: {
              ...baseRunOptions,
              model: "gpt-5-pro",
              browserFollowUps: ["substantive follow-up"],
            },
            browserConfig: { desiredModel: "GPT-5.6 Pro", thinkingTime: "pro" },
            cwd: "/repo",
            log,
          },
          {
            assemblePrompt: async () => ({
              markdown: "hi",
              composerText: "hi",
              estimatedInputTokens: 2,
              attachments: [],
              inlineFileCount: 0,
              tokenEstimateIncludesInlineFiles: false,
              attachmentsPolicy: "auto",
              attachmentMode: "inline",
              fallback: null,
            }),
            executeBrowser: vi.fn(async (options) => {
              await options.runtimeHintCb?.(activeRuntime);
              return {
                answerText: "private partially-receipted follow-up",
                answerMarkdown: "private partially-receipted follow-up",
                tookMs: 30_000,
                answerTokens: 4,
                answerChars: 37,
                ...activeRuntime,
              };
            }),
            persistRuntimeHint,
          },
        ),
      ).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "pro-workload-receipt-missing",
        }),
      });

      const persistedRuntime = persistRuntimeHint.mock.calls[0]?.[0];
      expect(persistedRuntime?.proInputTokens).toBe(activeWorkload.proInputTokens);
      expect(persistedRuntime?.proAttachmentBytes).toBe(activeWorkload.proAttachmentBytes);
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
        "private partially-receipted follow-up",
      );
    },
  );

  test("persists attach-mode runtime metadata from the browser runner", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      });
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        tookMs: 100,
        answerTokens: 2,
        answerChars: 2,
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      };
    });

    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: { attachRunning: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );

    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTransport: "cdp",
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      }),
    );
    expect(result.runtime).toMatchObject({
      browserTransport: "cdp",
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
      chromeTargetId: "target-2",
      tabUrl: "https://chatgpt.com/c/attached",
    });
  });

  test("suppresses automation noise when not verbose", async () => {
    const log = vi.fn();
    const noisyLogger = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("Prompt textarea ready");
          noisyLogger();
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => /Launching browser mode/.test(String(call[0])))).toBe(
      true,
    );
    expect(log.mock.calls.some((call) => /Prompt textarea ready/.test(String(call[0])))).toBe(
      false,
    );
    expect(noisyLogger).toHaveBeenCalled(); // ensure executeBrowser ran
  });

  test("prints fallback retry logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Inline prompt too large; retrying with file uploads.");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(
      log.mock.calls.some((call) => String(call[0]).includes("Inline prompt too large; retrying")),
    ).toBe(true);
  });

  test("prints browser thinking heartbeat logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] ChatGPT thinking - 30s elapsed; status=planning");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("ChatGPT thinking"))).toBe(true);
  });

  test("prints browser follow-up progress logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Sending follow-up 1/1");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("Sending follow-up"))).toBe(true);
  });

  test("prints browser control guidance even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.(
            "[browser] Browser control: launch visible Chrome; may focus/control the browser UI.",
          );
          automationLog?.(
            "[browser] Browser guidance: Use --browser-attach-running to reduce desktop disruption.",
          );
          automationLog?.("[browser] Prompt textarea ready");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );

    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser control"))).toBe(true);
    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser guidance"))).toBe(true);
    expect(log.mock.calls.some((call) => String(call[0]).includes("Prompt textarea ready"))).toBe(
      false,
    );
  });

  test("passes fallback submission through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 4,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: {
            composerText: "fallback prompt",
            attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1 }],
            bundled: null,
          },
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" })],
        },
      }),
    );
  });

  test("respects verbose logging", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: { keepBrowser: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1024 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "upload",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 10,
          answerTokens: 1,
          answerChars: 5,
        }),
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser attachments"))).toBe(
      true,
    );
  });

  test("verbose output spells out token labels", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("non-verbose output keeps short token label", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("uses a verified picker label in the live browser finish line", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, model: "gpt-5.5-pro" },
        browserConfig: { desiredModel: "Pro", modelStrategy: "select" },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
          modelSelection: {
            requestedModel: "Pro",
            resolvedLabel: "Pro",
            strategy: "select",
            status: "already-selected",
            verified: true,
            source: "chatgpt-model-picker",
            capturedAt: "2026-07-12T00:00:00.000Z",
          },
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toContain("Pro[browser]");
    expect(finishedLine).not.toContain("gpt-5.5-pro[browser]");
  });

  test("keeps the requested key in the live finish line when picker evidence is unverified", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, model: "gpt-5.5-pro" },
        browserConfig: { desiredModel: "Pro", modelStrategy: "current" },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
          modelSelection: {
            requestedModel: "Pro",
            resolvedLabel: "Thinking 5.5 Heavy",
            strategy: "current",
            status: "already-selected",
            verified: false,
            source: "chatgpt-model-picker",
            capturedAt: "2026-07-12T00:00:00.000Z",
          },
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toContain("gpt-5.5-pro[browser]");
    expect(finishedLine).not.toContain("Thinking 5.5 Heavy[browser]");
  });

  test("passes heartbeat interval through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 10,
      answerTokens: 1,
      answerChars: 5,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, heartbeatIntervalMs: 15_000 },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatIntervalMs: 15_000 }),
    );
  });

  test("rejects Gemini before prompt assembly or custom browser execution", async () => {
    const log = vi.fn();
    const assemblePrompt = vi.fn();
    const executeBrowser = vi.fn();
    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { ...baseRunOptions, model: "gemini-3-pro" },
          browserConfig: baseConfig,
          cwd: "/repo",
          log,
        },
        {
          assemblePrompt,
          executeBrowser,
        },
      ),
    ).rejects.toThrow(/GPT-5\.6 Pro.*OpenCLI.*Gemini/);
    expect(assemblePrompt).not.toHaveBeenCalled();
    expect(executeBrowser).not.toHaveBeenCalled();
  });
});
