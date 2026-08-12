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
): OpenCliCommandRunner {
  let postDispatchDetailCalls = 0;
  return async (_executable, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "--version") return { stdout: "1.8.3\n", stderr: "" };
    if (key === "doctor") return { stdout: "Browser Bridge connected\n", stderr: "" };
    if (args[0] === "chatgpt" && args[1] === "submit-file" && args.includes("--help")) {
      return {
        stdout:
          "Usage: opencli chatgpt submit-file <manifest> [options]\n\nArguments:\n  manifest  Path to a mode-0600 Oracle OpenCLI submission manifest\n\nOutput columns: ContractVersion, Status, conversationId, conversationUrl, Model, Files\n",
        stderr: "",
      };
    }
    if (args[0] === "chatgpt" && args[1] === "model") {
      events.push("model");
      return { stdout: JSON.stringify([{ Status: "Already selected", Model: "Pro" }]), stderr: "" };
    }
    if (args[0] === "chatgpt" && args[1] === "submit-file") {
      events.push("dispatch");
      events.push("receipt");
      return {
        stdout: JSON.stringify([
          {
            ContractVersion: 1,
            Status: "Submitted",
            conversationId: conversationUrl.split("/c/")[1],
            conversationUrl,
            Model: "Pro",
            Files: 1,
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "chatgpt" && args[1] === "detail") {
      events.push("detail");
      const dispatched = events.includes("dispatch");
      if (dispatched) postDispatchDetailCalls += 1;
      const returnBaseline = delayFollowupAnswer && (!dispatched || postDispatchDetailCalls <= 2);
      const assistantText = returnBaseline ? "Previous answer" : "Pro answer";
      const assistantIndex = returnBaseline ? 2 : 4;
      return {
        stdout: JSON.stringify([
          { Index: 1, Role: "User", Text: "attached request", Generating: false },
          { Index: assistantIndex, Role: "Assistant", Text: assistantText, Generating: false },
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
        sleep: async () => undefined,
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
    expect(result.tabUrl).toBe("https://chatgpt.com/c/conversation-123");
    expect(calls.flat()).not.toContain(privatePrompt);
    expect(calls.map((args) => args.join(" ")).join("\n")).not.toContain(privatePrompt);
    expect(events.indexOf("lock-acquired")).toBeLessThan(events.indexOf("model"));
    expect(events.indexOf("dispatch")).toBeLessThan(events.indexOf("lock-released"));
    expect(events.indexOf("lock-released")).toBeLessThan(events.indexOf("detail"));
    const submitCall = calls.find(
      (args) => args[0] === "chatgpt" && args[1] === "submit-file" && !args.includes("--help"),
    );
    expect(submitCall).toEqual(expect.arrayContaining(["--site-session", "ephemeral"]));
    expect(submitCall).toEqual(expect.arrayContaining(["--keep-tab", "false"]));
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
        sleep: async () => undefined,
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
    expect(events.filter((event) => event === "detail")).toHaveLength(5);
    expect(result.answerMarkdown).toBe("Pro answer");
    expect(result.opencliBaselineAssistantIndex).toBe(2);
    expect(result.opencliBaselineAssistantSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reattaches through detail only and never selects or dispatches again", async () => {
    const calls: string[][] = [];
    const events: string[] = [];
    const runtime: BrowserRuntimeMetadata = {
      browserTransport: "opencli",
      tabUrl: "https://chatgpt.com/c/pending-123",
      conversationId: "pending-123",
      promptSubmitted: true,
      opencliVersion: "1.8.3",
    };

    const result = await resumeOpenCliBrowserSession(
      runtime,
      { transport: "opencli", timeoutMs: 5_000 },
      (() => {}) as never,
      { runCommand: successRunner(calls, events), sleep: async () => undefined },
    );

    expect(result.answerMarkdown).toBe("Pro answer");
    expect(events).toContain("detail");
    expect(events).not.toContain("model");
    expect(events).not.toContain("dispatch");
    expect(calls.filter((args) => args[0] === "chatgpt" && args[1] === "detail")).toHaveLength(2);
  });

  it("fails closed for unsupported OpenCLI versions", () => {
    expect(() => __test__.parseCompatibleVersion("1.8.2")).toThrow(/1\.8\.3 or newer/u);
    expect(() => __test__.parseCompatibleVersion("2.0.0")).toThrow(/incompatible/u);
    expect(__test__.parseCompatibleVersion("1.8.3\n")).toBe("1.8.3");
    expect(__test__.parseCompatibleVersion("1.9.0")).toBe("1.9.0");
  });

  it("fails before model selection when the installed adapter contract is incompatible", async () => {
    const calls: string[][] = [];
    const sessionDir = await createTempDir();
    const runner: OpenCliCommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args.join(" ") === "--version") return { stdout: "1.8.3\n", stderr: "" };
      if (args.join(" ") === "doctor") {
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
    ).rejects.toThrow(/adapter is unavailable/u);

    expect(calls.some((args) => args[0] === "chatgpt" && args[1] === "model")).toBe(false);
  });

  it("accepts only explicit ChatGPT conversation receipts", () => {
    expect(__test__.extractConversationId("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(__test__.extractConversationId("https://example.com/c/abc-123")).toBeUndefined();
    expect(__test__.extractConversationId("https://chatgpt.com/new")).toBeUndefined();
  });
});
