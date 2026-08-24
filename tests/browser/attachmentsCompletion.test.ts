import { describe, expect, test, vi } from "vitest";
import {
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../../src/browser/pageActions.js";
import { buildCollisionRenamedAttachmentPattern } from "../../src/browser/actions/attachments.js";
import type { ChromeClient } from "../../src/browser/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe("collision-renamed attachment names", () => {
  test.each([
    ["App.tsx", "App(5).tsx"],
    ["App.tsx", "Remove file 1: App(5).tsx"],
    ["types.ts", "types(20260824-201700).ts"],
    ["types.ts", "Remove file 2: types(20260824-201700).ts"],
    ["a+b.jpg", "Remove file 3: a+b(2).jpg"],
  ])("matches %s to %s", (expectedName, actualName) => {
    expect(buildCollisionRenamedAttachmentPattern(expectedName)?.test(actualName) ?? false).toBe(
      true,
    );
  });

  test.each([
    ["App.tsx", "MyApp(5).tsx"],
    ["App.tsx", "App(5).ts"],
    ["App.tsx", "App.tsx.bak"],
    ["types.ts", "mytypes(1).ts"],
    ["types.ts", "typescript(1).ts"],
    ["report.pdf", "my_report.pdf"],
    ["attachments-bundle.txt", "not-attachments-bundle.txt"],
  ])("does not match %s to %s", (expectedName, actualName) => {
    expect(buildCollisionRenamedAttachmentPattern(expectedName)?.test(actualName) ?? false).toBe(
      false,
    );
  });

  test("waitForAttachmentCompletion resolves before timeout for seven files with two collision-renamed chips", async () => {
    useFakeTime();
    const expectedNames = [
      "d3-human-surface-refoundation-prototype-brief.md",
      "App.tsx",
      "types.ts",
      "compilePresentation.ts",
      "compilePresentation.test.ts",
      "ProgrammeTransect.tsx",
      "prototype.css",
    ];
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        value: {
          state: "ready",
          uploading: false,
          filesAttached: true,
          attachedNames: [
            "d3-human-surface-refoundation-prototype-brief.md",
            "Remove file 2: App(5).tsx",
            "Remove file 3: types(20260824-201700).ts",
            "compilePresentation.ts",
            "compilePresentation.test.ts",
            "ProgrammeTransect.tsx",
            "prototype.css",
          ],
          inputNames: [],
          fileCount: 0,
        },
      },
    });
    const runtime = {
      evaluate,
    } as unknown as ChromeClient["Runtime"];

    try {
      const promise = waitForAttachmentCompletion(runtime, 5_000, expectedNames);
      const outcome = promise.then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await outcome).toBe("resolved");
      expect(evaluate.mock.calls.length).toBeLessThan(20);
    } finally {
      useRealTime();
    }
  });

  test.each([
    ["App.tsx", "MyApp(5).tsx"],
    ["App.tsx", "App(5).ts"],
    ["App.tsx", "App.tsx.bak"],
    ["types.ts", "mytypes(1).ts"],
    ["types.ts", "typescript(1).ts"],
    ["report.pdf", "my_report.pdf"],
    ["attachments-bundle.txt", "not-attachments-bundle.txt"],
  ])("waitForAttachmentCompletion rejects %s near-match %s", async (expectedName, actualName) => {
    useFakeTime();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: true,
            attachedNames: [actualName],
            inputNames: [],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    try {
      const promise = waitForAttachmentCompletion(runtime, 3_000, [expectedName]);
      const outcome = promise.then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await outcome).toBe("rejected");
    } finally {
      useRealTime();
    }
  });
});

describe("attachment completion fallbacks", () => {
  test("waitForAttachmentCompletion resolves when ready file input contains expected name (no UI chip)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion does not resolve input-only match while upload is still flagged", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: true,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion resolves when all ready file input names match", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt", "b.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input misses an expected name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["a.txt", "b.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input has an unexpected extra name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt", "unexpected-extra.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 2_000, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion can resolve when send button is missing (input match fallback)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "missing",
            uploading: false,
            filesAttached: true,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when send button stays disabled (upload likely in progress)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "disabled",
            uploading: false,
            filesAttached: true,
            attachedNames: ["oracle-attach-verify.txt"],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when neither UI nor file input matches", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });
});

describe("sent turn attachment verification", () => {
  test("waitForUserTurnAttachments resolves when last user turn includes filename", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\noracle-attach-verify.txt\nDocument",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 1000),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments times out when filename never appears", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments skips when user turn lacks attachment UI", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment UI here)",
            attrs: [],
            hasAttachmentUi: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments resolves when attachment UI count satisfies expected files (no filename text)", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 2,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(
        runtime,
        ["oracle-attach-verify-a.txt", "oracle-attach-verify-b.txt"],
        1000,
      ),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments ignores turns before the expected baseline", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        minTurnIndex: 4,
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments requires prompt evidence when provided", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said: unrelated prompt oracle-attach-verify.txt",
            attrs: [],
            hasAttachmentUi: true,
            promptMatches: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedPrompt: "expected prompt text",
      },
    );
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments ignores mismatched conversations", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            conversationMismatch: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedConversationId: "conv-123",
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });
});
