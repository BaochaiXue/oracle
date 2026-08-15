import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __test__,
  resumeOpenCliBrowserSession,
  runOpenCliBrowserMode,
  type OpenCliCommandRunner,
} from "../../src/browser/opencliTransport.js";
import type { BrowserRuntimeMetadata } from "../../src/sessionStore.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-opencli-test-"));
  tempDirs.push(dir);
  return dir;
}

function successRunner(
  calls: string[][],
  events: string[],
  conversationUrl = "https://chatgpt.com/c/conversation-123",
  delayFollowupAnswer = false,
  dispatchAt = new Date(Date.now() - 120_000).toISOString(),
): OpenCliCommandRunner {
  return async (_executable, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "--version") return { stdout: "1.8.6\n", stderr: "" };
    if (key === "daemon status") {
      return { stdout: "Daemon: running\nExtension: connected (v1.0.22)\n", stderr: "" };
    }
    if (args[0] === "chatgpt" && args[1] === "submit-file" && args.includes("--help")) {
      return {
        stdout:
          "Usage: opencli chatgpt submit-file <manifest> [options]\n\nUse Oracle picker contract v3 to select GPT-5.6 Pro in the submission tab.\n\nArguments:\n  manifest  Path to a mode-0600 Oracle OpenCLI submission manifest\n\nOutput columns: ContractVersion, Status, conversationId, conversationUrl, Model, ModelStatus, ModelLabel, ThinkingStatus, ThinkingLabel, Files, BaselineAssistantIndex, BaselineAssistantSha256\n",
        stderr: "",
      };
    }
    if (args[0] === "chatgpt" && args[1] === "oracle-wait" && args.includes("--help")) {
      return {
        stdout:
          "Usage: opencli chatgpt oracle-wait <id> [options]\n\nArguments:\n  id  Conversation ID or full /c/<id> URL\n\nOutput columns: ContractVersion, Status, conversationId, conversationUrl, AssistantIndex, AssistantSha256, Markdown, StableSeconds\n",
        stderr: "",
      };
    }
    if (args[0] === "chatgpt" && args[1] === "submit-file") {
      const manifest = JSON.parse(await fs.readFile(args[2]!, "utf8")) as {
        journalPath: string;
        operationRef: string;
      };
      await fs.appendFile(
        manifest.journalPath,
        `${JSON.stringify({ event: "model-ready", operationRef: manifest.operationRef })}\n`,
      );
      events.push("model");
      await fs.appendFile(
        manifest.journalPath,
        `${JSON.stringify({
          event: "dispatch-intent",
          operationRef: manifest.operationRef,
          at: dispatchAt,
        })}\n`,
      );
      events.push("dispatch");
      events.push("receipt");
      return {
        stdout: JSON.stringify([
          {
            ContractVersion: 3,
            Status: "Submitted",
            conversationId: conversationUrl.split("/c/")[1],
            conversationUrl,
            Model: "GPT-5.6 Pro",
            ModelStatus: "already-selected",
            ModelLabel: "GPT-5.6 Sol",
            ThinkingStatus: "already-selected",
            ThinkingLabel: "Pro",
            Files: 1,
            BaselineAssistantIndex: delayFollowupAnswer ? 2 : undefined,
            BaselineAssistantSha256: delayFollowupAnswer
              ? createHash("sha256").update("Previous answer").digest("hex")
              : undefined,
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "chatgpt" && args[1] === "oracle-wait") {
      events.push("oracle-wait");
      return {
        stdout: JSON.stringify([
          {
            ContractVersion: 3,
            Status: "Complete",
            conversationId: conversationUrl.split("/c/")[1],
            conversationUrl,
            AssistantIndex: 4,
            AssistantSha256: createHash("sha256").update("Pro answer").digest("hex"),
            Markdown: "Pro answer",
            StableSeconds: 9,
          },
        ]),
        stderr: "",
      };
    }
    throw new Error(`Unexpected test command: ${key}`);
  };
}

describe("OpenCliBrowserTransport", () => {
  it("seals private prompt content in a 0600 artifact and never places it in argv", async () => {
    const sessionDir = await createTempDir();
    const calls: string[][] = [];
    const events: string[] = [];
    const runtimeHints: BrowserRuntimeMetadata[] = [];
    const privatePrompt = "PRIVATE_ORACLE_PROMPT_9fd1";

    const result = await runOpenCliBrowserMode(
      {
        prompt: privatePrompt,
        sessionId: "test-session",
        config: {
          transport: "opencli",
          desiredModel: "Pro",
          modelStrategy: "select",
          timeoutMs: 5_000,
          profileLockTimeoutMs: 5_000,
        },
        runtimeHintCb: (runtime) => {
          runtimeHints.push(runtime);
        },
      },
      {
        runCommand: successRunner(calls, events),
        resolveSessionDir: async () => sessionDir,
        randomId: () => "turn-1",
        acquireLock: async () => {
          events.push("lock-acquired");
          return {
            path: "/test/lock",
            lockId: "lock-1",
            release: async () => {
              events.push("lock-released");
            },
          };
        },
      },
    );

    expect(result.answerMarkdown).toBe("Pro answer");
    expect(result.browserTransport).toBe("opencli");
    expect(result.opencliWindowMode).toBe("background");
    expect(result.opencliDispatchAt).toBeTruthy();
    expect(result.opencliResponseElapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(result.tabUrl).toBe("https://chatgpt.com/c/conversation-123");
    expect(calls.flat()).not.toContain(privatePrompt);
    expect(calls.map((args) => args.join(" ")).join("\n")).not.toContain(privatePrompt);
    expect(events.indexOf("lock-acquired")).toBeLessThan(events.indexOf("model"));
    expect(events.indexOf("dispatch")).toBeLessThan(events.indexOf("lock-released"));
    expect(events.indexOf("lock-released")).toBeLessThan(events.indexOf("oracle-wait"));
    const submitCall = calls.find(
      (args) => args[0] === "chatgpt" && args[1] === "submit-file" && !args.includes("--help"),
    );
    expect(submitCall).toEqual(expect.arrayContaining(["--site-session", "ephemeral"]));
    expect(submitCall).toEqual(expect.arrayContaining(["--keep-tab", "true"]));
    expect(submitCall).toEqual(expect.arrayContaining(["--window", "background"]));
    expect(submitCall).toEqual(
      expect.arrayContaining(["--timeout", "225", "--trace", "retain-on-failure"]),
    );
    expect(calls.some((args) => args[0] === "chatgpt" && args[1] === "model")).toBe(false);
    const waitCalls = calls.filter(
      (args) => args[0] === "chatgpt" && args[1] === "oracle-wait" && !args.includes("--help"),
    );
    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]).toEqual(expect.arrayContaining(["--site-session", "ephemeral"]));
    expect(waitCalls[0]).toEqual(expect.arrayContaining(["--keep-tab", "true"]));
    expect(waitCalls[0]).toEqual(expect.arrayContaining(["--window", "background"]));
    expect(calls.some((args) => args[0] === "chatgpt" && args[1] === "detail")).toBe(false);
    expect(runtimeHints.at(-1)).toMatchObject({
      browserTransport: "opencli",
      conversationId: "conversation-123",
      promptSubmitted: true,
    });

    const artifactPath = result.artifacts?.[0]?.path;
    expect(artifactPath).toBeTruthy();
    expect(await fs.readFile(artifactPath!, "utf8")).toContain(privatePrompt);
    expect((await fs.stat(artifactPath!)).mode & 0o777).toBe(0o600);
  });

  it("opens the stored conversation explicitly for an Oracle follow-up", async () => {
    const sessionDir = await createTempDir();
    const calls: string[][] = [];
    const events: string[] = [];
    const storedConversation = "https://chatgpt.com/c/stored-followup";

    const result = await runOpenCliBrowserMode(
      {
        prompt: "follow-up payload",
        sessionId: "followup-session",
        config: {
          transport: "opencli",
          desiredModel: "Pro",
          modelStrategy: "select",
          resumeConversationUrl: storedConversation,
          timeoutMs: 5_000,
          profileLockTimeoutMs: 5_000,
        },
      },
      {
        runCommand: successRunner(calls, events, storedConversation, true),
        resolveSessionDir: async () => sessionDir,
        randomId: () => "turn-2",
        acquireLock: async () => ({
          path: "/test/lock",
          lockId: "lock-2",
          release: async () => undefined,
        }),
      },
    );

    const submitCall = calls.find(
      (args) => args[0] === "chatgpt" && args[1] === "submit-file" && !args.includes("--help"),
    );
    expect(submitCall).toEqual(expect.arrayContaining(["--conversation", storedConversation]));
    expect(submitCall).not.toEqual(expect.arrayContaining(["--new", "true"]));
    expect(events.filter((event) => event === "oracle-wait")).toHaveLength(1);
    expect(calls.some((args) => args[0] === "chatgpt" && args[1] === "detail")).toBe(false);
    expect(result.answerMarkdown).toBe("Pro answer");
    expect(result.opencliBaselineAssistantIndex).toBe(2);
    expect(result.opencliBaselineAssistantSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a stable assistant answer captured less than one minute after dispatch", async () => {
    const sessionDir = await createTempDir();
    const calls: string[][] = [];
    const events: string[] = [];
    const dispatchAt = "2026-08-13T01:00:00.000Z";
    const capturedAt = new Date("2026-08-13T01:00:42.000Z");

    const result = await runOpenCliBrowserMode(
      {
        prompt: "architecture review",
        sessionId: "fast-mini-gate",
        config: {
          transport: "opencli",
          desiredModel: "GPT-5.6 Pro",
          modelStrategy: "select",
          timeoutMs: 5_000,
        },
      },
      {
        runCommand: successRunner(
          calls,
          events,
          "https://chatgpt.com/c/fast-mini-answer",
          false,
          dispatchAt,
        ),
        resolveSessionDir: async () => sessionDir,
        now: () => capturedAt,
        randomId: () => "fast-turn",
        acquireLock: async () => ({
          path: "/test/lock",
          lockId: "fast-lock",
          release: async () => undefined,
        }),
      },
    );

    expect(result.answerText).toBe("Pro answer");
    expect(result.proResponseElapsedMs).toBe(42_000);

    const artifactsDir = path.join(sessionDir, "artifacts");
    const journalName = (await fs.readdir(artifactsDir)).find((name) =>
      name.startsWith("opencli-transport-"),
    );
    expect(journalName).toBeTruthy();
    const journal = await fs.readFile(path.join(artifactsDir, journalName!), "utf8");
    expect(journal).toContain('"event":"answer-captured"');
    expect(journal).not.toContain('"event":"rejected"');
    expect(journal).toContain('"event":"complete"');
  });

  it("refuses to harvest when a successful receipt lacks a durable dispatch timestamp", async () => {
    const sessionDir = await createTempDir();
    const calls: string[][] = [];
    const events: string[] = [];

    await expect(
      runOpenCliBrowserMode(
        {
          prompt: "architecture review",
          sessionId: "missing-dispatch-time",
          config: {
            transport: "opencli",
            desiredModel: "GPT-5.6 Pro",
            modelStrategy: "select",
          },
        },
        {
          runCommand: successRunner(
            calls,
            events,
            "https://chatgpt.com/c/missing-dispatch-time",
            false,
            "not-a-timestamp",
          ),
          resolveSessionDir: async () => sessionDir,
          acquireLock: async () => ({
            path: "/test/lock",
            lockId: "missing-time-lock",
            release: async () => undefined,
          }),
        },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "response-timing",
        code: "dispatch-timestamp-missing",
      },
    });

    expect(events).not.toContain("oracle-wait");
  });

  it("reattaches through one waiter command and never selects or dispatches again", async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = {
      browserTransport: "opencli",
      tabUrl: "https://chatgpt.com/c/pending-123",
      conversationId: "pending-123",
      promptSubmitted: true,
      opencliVersion: "1.8.6",
    };

    const result = await resumeOpenCliBrowserSession(
      runtime,
      { transport: "opencli", timeoutMs: 5_000 },
      (() => {}) as never,
      { runCommand: successRunner(calls, events) },
    );

    expect(result.answerMarkdown).toBe("Pro answer");
    expect(events).toContain("oracle-wait");
    expect(events).not.toContain("model");
    expect(events).not.toContain("dispatch");
    expect(
      calls.filter(
        (args) => args[0] === "chatgpt" && args[1] === "oracle-wait" && !args.includes("--help"),
      ),
    ).toHaveLength(1);
    expect(calls.some((args) => args[0] === "chatgpt" && args[1] === "detail")).toBe(false);
  });

  it("accepts a previously captured sub-minute answer on later reattach", async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = {
      browserTransport: "opencli",
      tabUrl: "https://chatgpt.com/c/fast-mini-answer",
      conversationId: "fast-mini-answer",
      promptSubmitted: true,
      opencliVersion: "1.8.6",
      opencliDispatchAt: "2026-08-13T01:00:00.000Z",
      opencliResponseElapsedMs: 42_000,
    };

    await expect(
      resumeOpenCliBrowserSession(
        runtime,
        { transport: "opencli", timeoutMs: 5_000 },
        (() => {}) as never,
        {
          runCommand: successRunner(calls, events),
          now: () => new Date("2026-08-13T01:10:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      answerText: "Pro answer",
      answerMarkdown: "Pro answer",
      runtime: expect.objectContaining({ opencliResponseElapsedMs: 42_000 }),
    });

    expect(events).toContain("oracle-wait");
    expect(events).not.toContain("dispatch");
  });

  it("fails closed for unsupported OpenCLI versions", () => {
    expect(() => __test__.parseCompatibleVersion("1.8.5")).toThrow(/1\.8\.6 or newer/u);
    expect(() => __test__.parseCompatibleVersion("2.0.0")).toThrow(/incompatible/u);
    expect(__test__.parseCompatibleVersion("1.8.6\n")).toBe("1.8.6");
    expect(__test__.parseCompatibleVersion("1.9.0")).toBe("1.9.0");
  });

  it("fails before submission when the installed same-tab picker contract is incompatible", async () => {
    const calls: string[][] = [];
    const sessionDir = await createTempDir();
    const runner: OpenCliCommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args.join(" ") === "--version") return { stdout: "1.8.6\n", stderr: "" };
      if (args.join(" ") === "daemon status") {
        return { stdout: "Browser Bridge connected\n", stderr: "" };
      }
      if (args.includes("--help")) {
        return { stdout: "Usage: opencli chatgpt submit-file <path>\n", stderr: "" };
      }
      throw new Error(`Unexpected test command: ${args.join(" ")}`);
    };

    await expect(
      runOpenCliBrowserMode(
        {
          prompt: "private prompt",
          sessionId: "wrong-adapter",
          config: { transport: "opencli", modelStrategy: "select" },
        },
        { runCommand: runner, resolveSessionDir: async () => sessionDir },
      ),
    ).rejects.toThrow(/adapters are unavailable/u);

    expect(
      calls.some(
        (args) => args[0] === "chatgpt" && args[1] === "submit-file" && !args.includes("--help"),
      ),
    ).toBe(false);
  });

  it("persists sanitized same-tab picker failure evidence without marking a submission", async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const sessionDir = await createTempDir();
    const baseRunner = successRunner(calls, events);
    const runner: OpenCliCommandRunner = async (executable, args, options) => {
      if (args[0] === "chatgpt" && args[1] === "submit-file" && !args.includes("--help")) {
        throw Object.assign(new Error("Command failed: opencli chatgpt submit-file"), {
          code: 77,
          stderr: [
            "ok: false",
            "error:",
            "  code: MODEL_UNCONFIRMED",
            "  message: Oracle native Pro selection failed before submission.",
            "trace:",
            "  summaryPath: /tmp/opencli-submit-trace/summary.md",
          ].join("\n"),
        });
      }
      return baseRunner(executable, args, options);
    };

    await expect(
      runOpenCliBrowserMode(
        {
          prompt: "private prompt",
          sessionId: "model-failure-evidence",
          config: { transport: "opencli", modelStrategy: "select" },
        },
        {
          runCommand: runner,
          resolveSessionDir: async () => sessionDir,
          acquireLock: async () => ({
            path: "/test/lock",
            lockId: "model-failure-lock",
            release: async () => undefined,
          }),
        },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "opencli-blocked",
        reason: "opencli-blocked",
        submitted: false,
        opencliFailure: {
          stage: "submit-file",
          code: "MODEL_UNCONFIRMED",
          message: "Oracle native Pro selection failed before submission.",
          exitCode: 77,
          traceSummaryPath: "/tmp/opencli-submit-trace/summary.md",
        },
      },
    });
    expect(events).not.toContain("dispatch");
  });

  it("accepts only explicit ChatGPT conversation receipts", () => {
    expect(__test__.extractConversationId("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(__test__.extractConversationId("https://example.com/c/abc-123")).toBeUndefined();
    expect(__test__.extractConversationId("https://chatgpt.com/new")).toBeUndefined();
  });
});
