import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import {
  getBatchPaths,
  listProtectedBatchSessionIds,
  readBatchState,
} from "../../src/batch/store.js";
import {
  acceptMissingBatchLane,
  acceptMissingBatchSynthesis,
  renderStoredBatch,
  resumeBatch,
  runBatch,
} from "../../src/batch/runtime.js";
import type { BatchChildExecutionContext } from "../../src/batch/runtime.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";
import type { BrowserPromptArtifacts } from "../../src/browser/prompt.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Batch Oracle runtime", () => {
  let home: string;
  let cwd: string;
  const browserConfig = {
    transport: "cdp",
    desiredModel: "GPT-5.6 Sol",
    modelStrategy: "select",
    thinkingTime: "pro",
    maxConcurrentTabs: 3,
  } as BrowserSessionConfig;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-runtime-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-runtime-cwd-"));
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("dispatches a blind ready set before barrier synthesis and preserves manifest order", async () => {
    await fs.writeFile(
      path.join(cwd, "batch.json5"),
      JSON.stringify(threeLaneManifest(true)),
      "utf8",
    );
    const gates = new Map([
      ["constitution", deferred()],
      ["cognition", deferred()],
      ["tribunal", deferred()],
    ]);
    const starts: string[] = [];
    const logs: string[] = [];
    let synthesisStarts = 0;
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      starts.push(`${context.role}:${context.laneId}`);
      if (context.role === "lane") {
        await gates.get(context.laneId)!.promise;
      } else {
        synthesisStarts += 1;
      }
      const answer =
        context.role === "synthesis"
          ? "# Contradiction matrix\n\n- constitution vs cognition"
          : `RAW ANSWER ${context.laneId}`;
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, answer, "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        browser: {
          config: context.browserConfig,
          runtime: {
            promptSubmitted: true,
            proTurnCommitted: true,
            conversationId: `conversation-${context.laneId}`,
          },
        },
      });
    });

    const running = runBatch(
      "batch.json5",
      { cwd, maxParallel: 3, log: (message) => logs.push(message) },
      { buildBrowserConfig: async () => browserConfig, dispatchChild },
    );
    await vi.waitFor(() => {
      expect(new Set(starts)).toEqual(
        new Set(["lane:constitution", "lane:cognition", "lane:tribunal"]),
      );
    });
    expect(logs.filter((line) => line.startsWith("Dispatching lane "))).toEqual([
      "Dispatching lane constitution...",
      "Dispatching lane cognition...",
      "Dispatching lane tribunal...",
    ]);
    gates.get("tribunal")!.resolve();
    await vi.waitFor(() => expect(dispatchChild).toHaveBeenCalledTimes(3));
    expect(synthesisStarts).toBe(0);
    gates.get("constitution")!.resolve();
    gates.get("cognition")!.resolve();
    const result = await running;

    expect(result.state.status).toBe("completed");
    expect(result.state.barrierClosedAt).toBeTruthy();
    expect(starts.at(-1)).toBe("synthesis:adjudication");
    expect(result.state.lanes.map((lane) => lane.sessionId)).toHaveLength(3);
    expect(result.state.synthesis?.sessionId).toBeTruthy();
    for (const lane of [...result.state.lanes, result.state.synthesis!]) {
      const child = await sessionStore.readSession(lane.sessionId!);
      expect(child?.batch).toEqual(
        expect.objectContaining({
          batchId: result.state.batchId,
          laneId: lane.id,
          inputManifestSha256: lane.inputManifestSha256,
        }),
      );
    }
    expect(logs.join("\n")).not.toContain("RAW ANSWER");
    const rendered = await renderStoredBatch(result.state.batchId, { all: true });
    expect(rendered.indexOf("Raw answer: constitution")).toBeLessThan(
      rendered.indexOf("Raw answer: cognition"),
    );
    expect(rendered.indexOf("Raw answer: cognition")).toBeLessThan(
      rendered.indexOf("Raw answer: tribunal"),
    );
    expect(rendered).toContain("Contradiction matrix");
  });

  test("seal failure creates zero child sessions", async () => {
    await fs.writeFile(
      path.join(cwd, "batch.json5"),
      JSON.stringify(threeLaneManifest(false)),
      "utf8",
    );
    const logs: string[] = [];
    await expect(
      runBatch(
        "batch.json5",
        { cwd, log: (message) => logs.push(message) },
        {
          buildBrowserConfig: async () => browserConfig,
          assemblePrompt: async () => {
            throw new Error("seal exploded");
          },
        },
      ),
    ).rejects.toThrow(/failed before dispatch/u);
    expect(await sessionStore.listSessions()).toHaveLength(0);
    const batchId = logs[0]!.replace("Batch ID: ", "");
    expect((await readBatchState(batchId)).status).toBe("error");
  });

  test("request gate pauses pending lanes and explicit resume creates only one safe next attempt", async () => {
    await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(twoLaneManifest()), "utf8");
    let firstPass = true;
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      if (firstPass && context.laneId === "one") {
        await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
          status: "error",
          completedAt: new Date().toISOString(),
        });
        await context.store.updateSession(context.sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: "request gate",
          error: {
            category: "browser-automation",
            message: "request gate",
            details: {
              code: "chatgpt-submission-gate",
              submissionCommitted: false,
              retrySafe: true,
              runtime: {
                promptSubmitted: false,
                proTurnCommitted: false,
              },
            },
          },
          browser: {
            config: context.browserConfig,
            runtime: { promptSubmitted: false, proTurnCommitted: false },
          },
        });
        throw new Error("request gate");
      }
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const initial = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 1, log: () => undefined },
      {
        buildBrowserConfig: async () => ({ ...browserConfig, maxConcurrentTabs: 1 }),
        dispatchChild,
      },
    );
    expect(initial.state.status).toBe("awaiting-recovery");
    expect(initial.state.lanes[0]?.attempts).toHaveLength(1);
    expect(initial.state.lanes[1]?.attempts).toHaveLength(1);
    const originalSecondSession = initial.state.lanes[1]!.sessionId;

    firstPass = false;
    const resumed = await resumeBatch(
      initial.state.batchId,
      { log: () => undefined },
      {
        buildBrowserConfig: async () => ({ ...browserConfig, maxConcurrentTabs: 1 }),
        dispatchChild,
      },
    );
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.lanes[0]?.attempts).toHaveLength(2);
    expect(resumed.state.lanes[0]?.sessionId).not.toBe(initial.state.lanes[0]?.sessionId);
    expect(resumed.state.lanes[1]?.sessionId).toBe(originalSecondSession);
    expect(resumed.state.lanes[1]?.attempts).toHaveLength(1);
  });

  test("resumes from a complete seal when child creation stopped before the first mapping", async () => {
    await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(twoLaneManifest()), "utf8");
    const createSpy = vi.spyOn(sessionStore, "createSession");
    createSpy.mockRejectedValueOnce(new Error("simulated crash after sealing"));
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const logs: string[] = [];
    await expect(
      runBatch(
        "batch.json5",
        { cwd, log: (message) => logs.push(message) },
        { buildBrowserConfig: async () => browserConfig, dispatchChild },
      ),
    ).rejects.toThrow(/simulated crash after sealing/u);
    createSpy.mockRestore();

    const batchId = logs[0]!.replace("Batch ID: ", "");
    const before = await readBatchState(batchId);
    expect(before.lastError?.code).toBe("batch-child-session-creation-failed");
    expect(before.lanes.every((lane) => !lane.sessionId)).toBe(true);
    const resumed = await resumeBatch(
      batchId,
      { log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild },
    );
    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.lanes.every((lane) => lane.attempts.length === 1)).toBe(true);
    expect(dispatchChild).toHaveBeenCalledTimes(2);
  });

  test("requires owner-explicit partial synthesis and records the missing lane honestly", async () => {
    const manifest = {
      ...twoLaneManifest(),
      policy: { maxParallel: 2, maxChildSessions: 3, partialSynthesis: "owner-explicit" },
      synthesis: {
        id: "judge",
        title: "Judge",
        prompt: "Adjudicate the available evidence.",
        requiredOutput: ["contradiction matrix"],
      },
    };
    await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(manifest), "utf8");
    let synthesisPrompt = "";
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      if (context.role === "lane" && context.laneId === "two") {
        await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
          status: "error",
          completedAt: new Date().toISOString(),
        });
        await context.store.updateSession(context.sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: "terminal reviewer failure",
        });
        return;
      }
      if (context.role === "synthesis") synthesisPrompt = context.artifacts.composerText;
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(
        context.outputPath,
        context.role === "synthesis" ? "PARTIAL SYNTHESIS" : `answer ${context.laneId}`,
        "utf8",
      );
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const assemblePrompt = async (options: {
      prompt: string;
    }): Promise<BrowserPromptArtifacts> => ({
      markdown: options.prompt,
      composerText: options.prompt,
      estimatedInputTokens: 10,
      attachments: [],
      inlineFileCount: 0,
      tokenEstimateIncludesInlineFiles: false,
      attachmentsPolicy: "always",
      attachmentMode: "upload",
      fallback: null,
      bundled: null,
    });
    const initial = await runBatch(
      "batch.json5",
      { cwd, log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild, assemblePrompt },
    );
    expect(initial.state.status).toBe("awaiting-owner");
    expect(dispatchChild.mock.calls.some(([context]) => context.role === "synthesis")).toBe(false);

    await acceptMissingBatchLane(
      initial.state.batchId,
      "two",
      "Reviewer exhausted without usable evidence.",
    );
    const resumed = await resumeBatch(
      initial.state.batchId,
      { allowPartial: true, log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild, assemblePrompt },
    );
    expect(resumed.state.status).toBe("partial");
    expect(synthesisPrompt).toContain("Missing or unavailable lanes: two (abandoned)");
    const paths = getBatchPaths(resumed.state.batchId);
    const errorReceipt = JSON.parse(
      await fs.readFile(path.join(paths.outputs, "lanes", "two", "answer-receipt.json"), "utf8"),
    ) as { status: string; error: string };
    expect(errorReceipt).toEqual(
      expect.objectContaining({
        status: "error",
        error: "terminal reviewer failure",
      }),
    );
    expect(await fs.readFile(paths.report, "utf8")).toContain("Status: partial");
  });

  test("lets the owner terminalize a nonterminal synthesis without resending or losing lane evidence", async () => {
    await fs.writeFile(
      path.join(cwd, "batch.json5"),
      JSON.stringify({
        ...twoLaneManifest(),
        policy: { maxParallel: 2, maxChildSessions: 3 },
        synthesis: {
          id: "adjudication",
          title: "Adjudication",
          prompt: "Resolve the contradiction.",
          requiredOutput: ["contradiction matrix"],
        },
      }),
      "utf8",
    );
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      if (context.role === "synthesis") {
        await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
          status: "error",
          completedAt: new Date().toISOString(),
        });
        await context.store.updateSession(context.sessionMeta.id, {
          status: "error",
          errorMessage: "Committed synthesis remained nonterminal.",
          browser: {
            config: context.browserConfig,
            runtime: {
              promptSubmitted: true,
              proTurnCommitted: true,
              conversationId: "synthesis-conversation",
              tabUrl: "https://chatgpt.com/c/synthesis-conversation",
              browserDisposition: "recoverable",
            },
          },
        });
        return;
      }
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });

    const initial = await runBatch(
      "batch.json5",
      { cwd, log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild },
    );
    expect(initial.state.status).toBe("awaiting-recovery");
    expect(initial.state.lanes.every((lane) => lane.status === "completed")).toBe(true);
    expect(initial.state.synthesis).toEqual(
      expect.objectContaining({ status: "recoverable", sessionId: expect.any(String) }),
    );
    const synthesisSessionId = initial.state.synthesis!.sessionId!;
    const dispatchCount = dispatchChild.mock.calls.length;

    const closed = await acceptMissingBatchSynthesis(
      initial.state.batchId,
      "Committed synthesis remained nonterminal after bounded exact recovery.",
    );
    expect(closed.status).toBe("partial");
    expect(closed.synthesis).toEqual(
      expect.objectContaining({
        status: "abandoned",
        acceptedMissing: true,
        sessionId: synthesisSessionId,
        abandonedAt: expect.any(String),
        lastError: expect.objectContaining({
          code: "batch-synthesis-accepted-missing",
          retrySafe: false,
        }),
      }),
    );
    expect(closed.ownerDecisions?.at(-1)).toEqual(
      expect.objectContaining({
        type: "accept-missing",
        stageId: "adjudication",
        stageRole: "synthesis",
        sessionId: synthesisSessionId,
      }),
    );
    expect(await sessionStore.readSession(synthesisSessionId)).not.toBeNull();
    expect(await listProtectedBatchSessionIds()).not.toContain(synthesisSessionId);
    const report = await fs.readFile(getBatchPaths(closed.batchId).report, "utf8");
    expect(report).toContain("Status: partial");
    expect(report).toContain("First-stage outcome: all lanes completed or owner-accepted");
    expect(report).toContain("Synthesis unavailable");
    expect(report).toContain(
      "Committed synthesis remained nonterminal after bounded exact recovery.",
    );

    const resumed = await resumeBatch(
      closed.batchId,
      { log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild },
    );
    expect(resumed.state.status).toBe("partial");
    expect(dispatchChild).toHaveBeenCalledTimes(dispatchCount);
  });

  test("does not create duplicate synthesis when a concurrent resume sees a live reservation", async () => {
    await fs.writeFile(
      path.join(cwd, "batch.json5"),
      JSON.stringify({
        ...twoLaneManifest(),
        policy: { maxParallel: 2, maxChildSessions: 3 },
        synthesis: {
          id: "judge",
          title: "Judge",
          prompt: "Adjudicate.",
          requiredOutput: ["contradiction matrix"],
        },
      }),
      "utf8",
    );
    const synthesisSeal = deferred();
    const synthesisEntered = deferred();
    let synthesisAssemblies = 0;
    const assemblePrompt = async (options: { prompt: string }): Promise<BrowserPromptArtifacts> => {
      if (options.prompt.includes("CONTRADICTION-FIRST SYNTHESIS")) {
        synthesisAssemblies += 1;
        synthesisEntered.resolve();
        await synthesisSeal.promise;
      }
      return {
        markdown: options.prompt,
        composerText: options.prompt,
        estimatedInputTokens: 10,
        attachments: [],
        inlineFileCount: 0,
        tokenEstimateIncludesInlineFiles: false,
        attachmentsPolicy: "always",
        attachmentMode: "upload",
        fallback: null,
        bundled: null,
      };
    };
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const logs: string[] = [];
    const running = runBatch(
      "batch.json5",
      { cwd, log: (message) => logs.push(message) },
      { buildBrowserConfig: async () => browserConfig, dispatchChild, assemblePrompt },
    );
    await synthesisEntered.promise;
    const batchId = logs[0]!.replace("Batch ID: ", "");
    const concurrent = await resumeBatch(
      batchId,
      { log: () => undefined },
      { buildBrowserConfig: async () => browserConfig, dispatchChild, assemblePrompt },
    );
    expect(concurrent.state.synthesis?.sessionId).toBeUndefined();
    expect(synthesisAssemblies).toBe(1);

    synthesisSeal.resolve();
    const completed = await running;
    expect(completed.state.status).toBe("completed");
    expect(completed.state.synthesis?.attempts).toHaveLength(1);
    expect(
      dispatchChild.mock.calls.filter(([context]) => context.role === "synthesis"),
    ).toHaveLength(1);
  });

  test("blocks synthesis when an accepted lane answer is tampered after receipt", async () => {
    await fs.writeFile(
      path.join(cwd, "batch.json5"),
      JSON.stringify({
        ...twoLaneManifest(),
        policy: { maxParallel: 1, maxChildSessions: 3 },
        synthesis: {
          id: "judge",
          title: "Judge",
          prompt: "Adjudicate.",
          requiredOutput: ["contradiction matrix"],
        },
      }),
      "utf8",
    );
    let firstOutput = "";
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      if (context.laneId === "one") firstOutput = context.outputPath;
      if (context.laneId === "two") await fs.writeFile(firstOutput, "tampered", "utf8");
      await context.store.updateModelRun(context.sessionMeta.id, "gpt-5-pro", {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const result = await runBatch(
      "batch.json5",
      { cwd, maxParallel: 1, log: () => undefined },
      {
        buildBrowserConfig: async () => ({ ...browserConfig, maxConcurrentTabs: 1 }),
        dispatchChild,
      },
    );
    expect(result.state.status).toBe("awaiting-owner");
    expect(result.state.lanes[0]?.lastError?.code).toBe("batch-answer-integrity-mismatch");
    expect(result.state.synthesis?.sessionId).toBeUndefined();
  });

  test("run and concurrent resume share one atomic claim per lane", async () => {
    await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(twoLaneManifest()), "utf8");
    const firstGate = deferred();
    const logs: string[] = [];
    const dispatchChild = vi.fn(async (context: BatchChildExecutionContext) => {
      if (context.laneId === "one") await firstGate.promise;
      await fs.mkdir(path.dirname(context.outputPath), { recursive: true });
      await fs.writeFile(context.outputPath, `answer ${context.laneId}`, "utf8");
      await context.store.updateSession(context.sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    });
    const running = runBatch(
      "batch.json5",
      { cwd, maxParallel: 1, log: (message) => logs.push(message) },
      {
        buildBrowserConfig: async () => ({ ...browserConfig, maxConcurrentTabs: 1 }),
        dispatchChild,
      },
    );
    await vi.waitFor(() => expect(dispatchChild).toHaveBeenCalledTimes(1));
    const batchId = logs[0]!.replace("Batch ID: ", "");
    const concurrent = await resumeBatch(
      batchId,
      { log: () => undefined },
      {
        buildBrowserConfig: async () => ({ ...browserConfig, maxConcurrentTabs: 1 }),
        dispatchChild,
      },
    );
    expect(concurrent.state.status).toBe("awaiting-recovery");
    expect(dispatchChild).toHaveBeenCalledTimes(1);
    firstGate.resolve();
    const completed = await running;
    expect(completed.state.status).toBe("completed");
    expect(dispatchChild).toHaveBeenCalledTimes(2);
    expect(completed.state.lanes.every((lane) => lane.attempts.length === 1)).toBe(true);
  });
});

function threeLaneManifest(withSynthesis: boolean) {
  return {
    schemaVersion: "oracle.batch.v1",
    slug: "runtime-batch",
    project: "fixture",
    objective: "Exercise the stage barrier.",
    policy: {
      maxParallel: 3,
      maxChildSessions: withSynthesis ? 4 : 3,
      revealLaneAnswersBeforeBarrier: false,
    },
    lanes: [
      lane("constitution", "Review constitution"),
      lane("cognition", "Review cognition"),
      lane("tribunal", "Review tribunal"),
    ],
    ...(withSynthesis
      ? {
          synthesis: {
            id: "adjudication",
            title: "Adjudication",
            prompt: "Adjudicate contradictions.",
            requiredOutput: ["contradiction matrix"],
          },
        }
      : {}),
  };
}

function twoLaneManifest() {
  return {
    schemaVersion: "oracle.batch.v1",
    slug: "request-gate-batch",
    project: "fixture",
    objective: "Exercise request gates.",
    policy: { maxParallel: 1, maxChildSessions: 2, revealLaneAnswersBeforeBarrier: false },
    lanes: [lane("one", "Review one"), lane("two", "Review two")],
  };
}

function lane(id: string, prompt: string) {
  return {
    id,
    title: id,
    mandate: `Mandate ${id}`,
    whyThisLane: `Why ${id}`,
    falsificationTarget: `Falsify ${id}`,
    prompt,
    outputContract: [`Output ${id}`],
  };
}
