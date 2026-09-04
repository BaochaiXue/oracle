import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";

class RetryGateFakeElement {
  readonly dataset: Record<string, string> = {};
  readonly childNodes: RetryGateFakeElement[] = [];
  readonly children: RetryGateFakeElement[] = [];
  readonly classList = { contains: () => false };
  readonly click = vi.fn();
  innerText = "";
  textContent = "";

  constructor(readonly attributes: Record<string, string> = {}) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return name in this.attributes;
  }

  getBoundingClientRect() {
    return { width: 10, height: 10 };
  }

  querySelector(selector: string) {
    return selector === ".whitespace-pre-wrap" ? this : null;
  }
}

class RetryGateFakeTextArea extends RetryGateFakeElement {
  value = "";
}

async function runRetainedDraftRetryGate({
  baseline = 0,
  composerValue = "hello",
  currentDocumentToken = "document-token",
  expectedDocumentToken = "document-token",
  href = "https://chatgpt.com/",
  stopVisible = false,
  turns = [],
  isSubmissionOwner = () => true,
}: {
  baseline?: number;
  composerValue?: string;
  currentDocumentToken?: string | null;
  expectedDocumentToken?: string;
  href?: string;
  stopVisible?: boolean;
  turns?: Array<{ role: "assistant" | "user"; text: string }>;
  isSubmissionOwner?: () => boolean | Promise<boolean>;
} = {}) {
  const composer = new RetryGateFakeTextArea();
  composer.value = composerValue;
  const turnNodes = turns.map(({ role, text }) => {
    const node = new RetryGateFakeElement({ "data-message-author-role": role });
    node.innerText = text;
    node.textContent = text;
    return node;
  });
  const stopButton = new RetryGateFakeElement();
  const sendButton = new RetryGateFakeElement();
  const fakeDocument = {
    querySelector: () => composer,
    querySelectorAll: (selector: string) => {
      if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return turnNodes;
      if (selector === CONVERSATION_TURN_SELECTOR) return turnNodes;
      if (selector === '[data-testid="stop-button"]') return stopVisible ? [stopButton] : [];
      if (selector.includes("send") || selector.includes('type="submit"')) {
        return [sendButton];
      }
      return [];
    },
  };
  if (currentDocumentToken !== null) {
    Object.defineProperty(fakeDocument, promptComposer.submissionDocumentTokenProperty, {
      value: currentDocumentToken,
    });
  }
  const browserWindow = {
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      pointerEvents: "auto",
    }),
  };
  const location = { href };
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: Function(
          "document",
          "window",
          "location",
          "HTMLElement",
          "HTMLTextAreaElement",
          "Node",
          "URL",
          `return ${expression}`,
        )(
          fakeDocument,
          browserWindow,
          location,
          RetryGateFakeElement,
          RetryGateFakeTextArea,
          { TEXT_NODE: 3 },
          URL,
        ),
      },
    })),
  };
  const result = await promptComposer.attemptRetainedDraftPageRetry({
    Runtime: runtime as never,
    prompt: "hello",
    baseline,
    submissionOwnerHref: href,
    submissionDocumentToken: expectedDocumentToken,
    isSubmissionOwner,
  });
  return { result, runtime, sendButton };
}

describe("promptComposer", () => {
  test("reconstructs exact multiline text from ProseMirror blocks", () => {
    class FakeNode {
      static TEXT_NODE = 3;

      nodeType = 1;
      nodeValue: string | null = null;
    }
    class FakeText extends FakeNode {
      override nodeType = FakeNode.TEXT_NODE;

      constructor(override nodeValue: string) {
        super();
      }
    }
    class FakeElement extends FakeNode {
      isContentEditable = false;

      constructor(
        readonly tagName: string,
        readonly childNodes: FakeNode[] = [],
        readonly classNames: string[] = [],
      ) {
        super();
      }

      get children() {
        return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
      }

      get classList() {
        return { contains: (name: string) => this.classNames.includes(name) };
      }

      getAttribute(name: string) {
        return name === "contenteditable" && this.isContentEditable ? "true" : null;
      }
    }
    class FakeTextArea extends FakeElement {
      value = "";

      constructor() {
        super("TEXTAREA");
      }
    }

    const paragraph = (text: string) => new FakeElement("P", [new FakeText(text)]);
    const blankParagraph = new FakeElement("P", [
      new FakeElement("BR", [], ["ProseMirror-trailingBreak"]),
    ]);
    const hardBreakParagraph = new FakeElement("P", [
      new FakeText("line 3"),
      new FakeElement("BR"),
      new FakeText("continued"),
    ]);
    const editor = new FakeElement("DIV", [
      paragraph("line 1"),
      blankParagraph,
      paragraph("line 2"),
      hardBreakParagraph,
    ]);
    editor.isContentEditable = true;

    const readComposerValue = Function(
      "node",
      "Node",
      "HTMLElement",
      "HTMLTextAreaElement",
      `${promptComposer.composerValueReaderSource}\nreturn readComposerValue(node);`,
    ) as (
      node: FakeElement,
      nodeClass: typeof FakeNode,
      elementClass: typeof FakeElement,
      textareaClass: typeof FakeTextArea,
    ) => string;

    expect(readComposerValue(editor, FakeNode, FakeElement, FakeTextArea)).toBe(
      "line 1\n\nline 2\nline 3\ncontinued",
    );
  });

  test("keeps textarea values byte-for-byte apart from newline normalization", () => {
    class FakeNode {
      static TEXT_NODE = 3;
    }
    class FakeElement {}
    class FakeTextArea extends FakeElement {
      constructor(readonly value: string) {
        super();
      }
    }
    const textarea = new FakeTextArea("first\r\nsecond");
    const readComposerValue = Function(
      "node",
      "Node",
      "HTMLElement",
      "HTMLTextAreaElement",
      `${promptComposer.composerValueReaderSource}\nreturn readComposerValue(node);`,
    ) as (
      node: FakeTextArea,
      nodeClass: typeof FakeNode,
      elementClass: typeof FakeElement,
      textareaClass: typeof FakeTextArea,
    ) => string;

    expect(readComposerValue(textarea, FakeNode, FakeElement, FakeTextArea)).toBe(
      "first\r\nsecond",
    );
  });

  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
  });

  test("does not treat historical assistant content as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "new prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("classifies a committed user turn with stray appended input as submitted-unverified, never as unsent", async () => {
    vi.useFakeTimers();
    try {
      const content = { innerText: "hello x", textContent: "hello x" };
      const userTurn = {
        innerText: "hello x",
        dataset: { turn: "user" },
        getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
        querySelector: (selector: string) => (selector === ".whitespace-pre-wrap" ? content : null),
      };
      const document = {
        querySelector: (selector: string) =>
          selector === '[data-testid="stop-button"]' ? {} : null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? [userTurn] : [],
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/mutated" }),
          },
        })),
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        0,
      );
      // The turn on the page is not the exact prompt, so identity stays
      // unverified, but a new user turn exists and the composer is empty:
      // something was sent, and sending again would duplicate it.
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "prompt-commit-identity-unverified",
          promptSubmitted: true,
          retrySafe: false,
          commitProbe: expect.objectContaining({
            lastMatched: false,
            lastUserTurnAvailable: true,
            hasNewUserTurn: true,
          }),
        }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commit timeout throws a structured error with probe diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 10,
        turnsCount: 10,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: true,
        inConversation: false,
        editorValue: "",
        lastTurn: "previous turn text",
      };
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls + final diagnostic probe
          .mockResolvedValue({ result: { value: probe } }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as {
        name?: string;
        details?: Record<string, unknown>;
        message?: string;
      };
      expect(error.message).toMatch(/prompt did not appear/i);
      expect(error.name).toBe("BrowserAutomationError");
      expect(error.details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-commit-timeout",
        commitProbe: expect.objectContaining({
          hasNewTurn: false,
          composerCleared: true,
          turnsCount: 10,
          lastTurnLength: "previous turn text".length,
        }),
      });
      // Free text must not leak into the structured details.
      const commitProbe = error.details?.commitProbe as Record<string, unknown>;
      expect(commitProbe).not.toHaveProperty("lastTurn");
      expect(commitProbe).not.toHaveProperty("editorValue");
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts a committed follow-up in a virtualized thread whose rendered turn count did not grow", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count): the thread already renders 5 turns.
          .mockResolvedValueOnce({ result: { value: 5 } })
          // After Send: still 5 rendered turns (one scrolled out), but the
          // prompt is the last user turn, the composer is empty, and Stop shows.
          .mockResolvedValue({
            result: {
              value: {
                baseline: 5,
                turnsCount: 5,
                userMatched: true,
                matchedUserTurnIndex: 3,
                lastMatched: true,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: true,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "rebuttal", 150);
      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).resolves.toEqual({ turnsCount: 5, userTurnIndex: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a matching historical turn when baseline turn count cannot be read", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read fails
          .mockRejectedValueOnce(new Error("turn read failed"))
          // Polls show only a historical prompt match (baseline unknown)
          .mockResolvedValue({
            result: {
              value: {
                baseline: -1,
                turnsCount: 1,
                userMatched: true,
                prefixMatched: false,
                lastMatched: true,
                hasNewTurn: false,
                stopVisible: false,
                assistantVisible: false,
                composerCleared: false,
                inConversation: true,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not infer a commit when no semantic user turn is available", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: false,
              lastMatched: false,
              lastUserTurnAvailable: false,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: true,
              composerCleared: true,
              inConversation: true,
            },
          },
        }),
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        0,
      );
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "prompt-commit-timeout",
          commitProbe: expect.objectContaining({
            lastMatched: false,
            lastUserTurnAvailable: false,
            hasNewTurn: true,
          }),
        }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports a retained composer draft as an uncommitted submission", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 0,
        turnsCount: 0,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: false,
        inConversation: false,
        editorValue: "unsent prompt",
        lastTurn: "",
      };
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 0 } })
          .mockResolvedValue({ result: { value: probe } }),
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "unsent prompt", 150);
      const assertion = expect(promise).rejects.toMatchObject({
        message:
          "Prompt remained in the composer after the send attempt; submission did not commit.",
        details: expect.objectContaining({
          code: "prompt-commit-timeout",
          submissionCommitted: false,
          draftRetained: true,
        }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toMatchObject({
        message: expect.stringMatching(/after 180s/i),
        details: expect.objectContaining({
          code: "attachment-send-not-ready",
          promptSubmitted: false,
          submissionCommitted: false,
          retrySafe: true,
        }),
      });
      await vi.advanceTimersByTimeAsync(181_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(180_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("marks a large prompt rejected before commit as retry-safe", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async () => ({
          result: {
            value: {
              baseline: 0,
              turnsCount: 0,
              userMatched: false,
              hasNewTurn: false,
              hasNewUserTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: false,
              editorValue: "",
            },
          },
        })),
      };
      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "x".repeat(50_000),
        150,
      );
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "prompt-too-large",
          promptSubmitted: false,
          submissionCommitted: false,
          retrySafe: true,
        }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("records dispatch before marking a verified prompt commit", async () => {
    const callbacks: string[] = [];
    const onPromptDispatched = vi.fn(() => {
      callbacks.push("dispatched");
    });
    const onPromptCommitted = vi.fn(() => {
      callbacks.push("committed");
    });
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 2,
              userMatched: true,
              matchedUserTurnIndex: 0,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptDispatched,
        onPromptCommitted,
      },
      "hello",
      logger as never,
    );

    expect(onPromptDispatched).toHaveBeenCalledTimes(1);
    expect(onPromptCommitted).toHaveBeenCalledTimes(1);
    expect(onPromptCommitted).toHaveBeenCalledWith(2, 0);
    expect(callbacks).toEqual(["dispatched", "committed"]);
  });

  test("sends without activating the ChatGPT page", async () => {
    const actions: string[] = [];
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          actions.push("send-click");
          return { result: { value: { status: "clicked" } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
      },
      "hello",
      logger as never,
    );

    expect(actions).toEqual(["send-click"]);
  });

  test("retries one retained draft through an atomic page-side gate without Enter", async () => {
    vi.useFakeTimers();
    try {
      let retryDispatched = false;
      let retryChecks = 0;
      const isSubmissionOwner = vi.fn(() => true);
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("focused: true")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("editorText")) {
            return {
              result: {
                value: {
                  editorText: "hello",
                  fallbackValue: "",
                  activeValue: "hello",
                  href: "https://chatgpt.com/",
                  documentTokenStored: true,
                },
              },
            };
          }
          if (expression.includes("expectedOwnerHref")) {
            retryChecks += 1;
            retryDispatched = true;
            return {
              result: {
                value: {
                  status: "dispatched",
                  gate: {
                    submissionCommitted: false,
                    draftRetained: true,
                    composerMatchesPrompt: true,
                    hasNewTurn: false,
                    userMatched: false,
                    stopVisible: false,
                    assistantVisible: false,
                    baselineKnown: true,
                    baselineUnchanged: true,
                    ownerMatched: true,
                    documentTokenMatched: true,
                  },
                },
              },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "clicked" } } };
          }
          return {
            result: {
              value: retryDispatched
                ? {
                    baseline: 0,
                    turnsCount: 2,
                    userMatched: true,
                    matchedUserTurnIndex: 0,
                    lastMatched: true,
                    hasNewTurn: true,
                    stopVisible: true,
                    assistantVisible: true,
                    composerCleared: true,
                    composerMatchesPrompt: false,
                    inConversation: true,
                  }
                : {
                    baseline: 0,
                    turnsCount: 0,
                    userMatched: false,
                    matchedUserTurnIndex: null,
                    lastMatched: false,
                    hasNewTurn: false,
                    stopVisible: false,
                    assistantVisible: false,
                    composerCleared: false,
                    composerMatchesPrompt: true,
                    inConversation: false,
                  },
            },
          };
        }),
      };
      const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
          isSubmissionOwner,
        },
        "hello",
        logger as never,
      );
      const assertion = expect(result).resolves.toBe(2);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;

      expect(isSubmissionOwner).toHaveBeenCalledTimes(1);
      expect(retryChecks).toBe(1);
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(logger).toHaveBeenCalledWith("Retained-draft Send retry decision: dispatched");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not let a post-dispatch fallback count authorize retry", async () => {
    vi.useFakeTimers();
    try {
      let commitProbes = 0;
      let fallbackCountReads = 0;
      let sendDispatched = false;
      const isSubmissionOwner = vi.fn(() => true);
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("focused: true")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("editorText")) {
            return {
              result: {
                value: {
                  editorText: "hello",
                  fallbackValue: "",
                  activeValue: "hello",
                  href: "https://chatgpt.com/",
                  documentTokenStored: true,
                },
              },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            sendDispatched = true;
            return { result: { value: { status: "clicked" } } };
          }
          if (expression.trimEnd().endsWith(").length")) {
            fallbackCountReads += 1;
            return { result: { value: 1 } };
          }
          commitProbes += 1;
          const committed = commitProbes >= 25;
          return {
            result: {
              value: {
                baseline: 1,
                turnsCount: committed ? 2 : 1,
                userMatched: committed,
                matchedUserTurnIndex: committed ? 1 : null,
                lastMatched: committed,
                hasNewTurn: committed,
                stopVisible: committed,
                assistantVisible: false,
                composerCleared: committed,
                inConversation: committed,
                editorValue: committed ? "" : "hello",
              },
            },
          };
        }),
      };
      const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: null,
          isSubmissionOwner,
        },
        "hello",
        logger as never,
      );
      const assertion = expect(result).resolves.toBe(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      expect(sendDispatched).toBe(true);
      expect(fallbackCountReads).toBe(1);
      expect(isSubmissionOwner).not.toHaveBeenCalled();
      expect(runtime.evaluate).not.toHaveBeenCalledWith(
        expect.objectContaining({ expression: expect.stringContaining("expectedDocumentToken") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("excludes attachment submissions from retained-draft recovery", async () => {
    let postVerificationExpression = "";
    const isSubmissionOwner = vi.fn(() => true);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          postVerificationExpression = expression;
          return {
            result: {
              value: {
                editorText: "hello",
                fallbackValue: "",
                activeValue: "hello",
                href: "https://chatgpt.com/",
                documentTokenStored: true,
              },
            },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        if (expression.includes("const expected =")) {
          return { result: { value: true } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              matchedUserTurnIndex: 0,
              lastMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          attachmentNames: ["oracle-attach-verify.txt"],
          baselineTurns: 0,
          isSubmissionOwner,
        },
        "hello",
        logger as never,
      ),
    ).resolves.toBe(1);

    expect(postVerificationExpression).toContain("const submissionDocumentToken = null");
    expect(isSubmissionOwner).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("dispatches at most one retained-draft retry while commit remains absent", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async () => ({
          result: {
            value: {
              baseline: 0,
              turnsCount: 0,
              userMatched: false,
              lastMatched: false,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: false,
              editorValue: "hello",
            },
          },
        })),
      };
      const retry = vi.fn(async () => ({ status: "dispatched" as const }));

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        2_250,
        undefined,
        0,
        undefined,
        retry,
      );
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "prompt-commit-timeout",
          submissionCommitted: false,
        }),
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await assertion;

      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels the retry when the first click commits during the atomic recheck", async () => {
    // This DOM is the delayed-first-click state visible at the recovery
    // boundary: the original user turn and streaming signal have just appeared.
    const { result, runtime, sendButton } = await runRetainedDraftRetryGate({
      stopVisible: true,
      turns: [{ role: "user", text: "hello" }],
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "gate-closed",
      gate: {
        submissionCommitted: true,
        hasNewTurn: true,
        userMatched: true,
        stopVisible: true,
      },
    });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  test.each([
    ["unknown pre-dispatch baseline", { baseline: -1 }, "baselineKnown"],
    [
      "changed pre-dispatch baseline",
      { turns: [{ role: "user" as const, text: "different" }] },
      "baselineUnchanged",
    ],
    ["composer mismatch", { composerValue: "changed" }, "composerMatchesPrompt"],
  ])("blocks retained-draft retry for %s", async (_label, scenario, deniedField) => {
    const { result, sendButton } = await runRetainedDraftRetryGate(scenario);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "gate-closed",
      gate: { [deniedField]: false },
    });
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  test("blocks a same-target same-href replacement document", async () => {
    const { result, sendButton } = await runRetainedDraftRetryGate({
      currentDocumentToken: null,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "gate-closed",
      gate: {
        ownerMatched: true,
        documentTokenMatched: false,
      },
    });
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  test("fails the retained-draft retry closed when target ownership changes", async () => {
    const runtime = { evaluate: vi.fn() };

    await expect(
      promptComposer.attemptRetainedDraftPageRetry({
        Runtime: runtime as never,
        prompt: "hello",
        baseline: 0,
        submissionOwnerHref: "https://chatgpt.com/",
        submissionDocumentToken: "document-token",
        isSubmissionOwner: () => false,
      }),
    ).resolves.toEqual({ status: "blocked", reason: "target-owner-mismatch" });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("fails the retained-draft retry closed when the owner probe errors", async () => {
    const ownerError = new Error("owner probe unavailable");
    const { result, runtime, sendButton } = await runRetainedDraftRetryGate({
      isSubmissionOwner: () => {
        throw ownerError;
      },
    });

    expect(result).toEqual({ status: "blocked", reason: "target-owner-check-failed" });
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  test("refuses to send when external input mutates the composer", async () => {
    let composerRead = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          composerRead += 1;
          const value = composerRead === 1 ? "hello" : "hellox";
          return {
            result: { value: { editorText: value, fallbackValue: "", activeValue: value } },
          };
        }
        throw new Error("send must not be attempted after composer mutation");
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      ),
    ).rejects.toMatchObject({
      message: "Prompt composer changed after Oracle populated it; refusing to send.",
      details: {
        code: "composer-mutated-before-send",
        submissionCommitted: false,
        draftRetained: true,
        expectedLength: 5,
        observedLength: 6,
      },
    });
    expect(runtime.evaluate).not.toHaveBeenCalledWith(
      expect.objectContaining({ expression: expect.stringContaining("button.scrollIntoView") }),
    );
  });

  test("refuses a mutation that arrives while the send button is settling", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "mutated", observedLength: 6 } } };
        }
        return { result: { value: true } };
      }),
    };
    const input = {
      insertText: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      dispatchMouseEvent: vi.fn(),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "composer-mutated-before-send",
        submissionCommitted: false,
        expectedLength: 5,
        observedLength: 6,
      }),
    });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("keeps a gated send attempt uncommitted", async () => {
    const onPromptDispatched = vi.fn();
    const onPromptCommitted = vi.fn();
    const gateError = new Error("request frequency gate");
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 0,
              userMatched: false,
              prefixMatched: false,
              lastMatched: false,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: false,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
          onPromptDispatched,
          onPromptCommitted,
          onPromptCommitPending: () => {
            throw gateError;
          },
        },
        "hello",
        logger as never,
      ),
    ).rejects.toBe(gateError);

    expect(onPromptDispatched).toHaveBeenCalledTimes(1);
    expect(onPromptCommitted).not.toHaveBeenCalled();
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
