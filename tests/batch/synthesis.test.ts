import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { initializeBatchStore, writeBatchState } from "../../src/batch/store.js";
import {
  BatchSynthesisInputTooLargeError,
  buildSynthesisPrompt,
  sealSynthesisInput,
} from "../../src/batch/synthesis.js";
import type { BrowserPromptArtifacts } from "../../src/browser/prompt.js";
import type { BatchSourceManifestV1, LoadedBatchManifest } from "../../src/batch/types.js";

describe("batch synthesis", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-synthesis-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-synthesis-cwd-"));
    setOracleHomeDirOverrideForTest(home);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("names missing lanes and preserves contradiction-first output requirements", async () => {
    const { loaded, state } = await fixtureState(cwd);
    const partial = {
      ...state,
      lanes: state.lanes.map((lane, index) =>
        index === 1
          ? { ...lane, status: "error" as const, acceptedMissing: true }
          : { ...lane, status: "completed" as const },
      ),
    };
    const prompt = buildSynthesisPrompt(loaded.manifest, partial);
    expect(prompt).toContain("Missing or unavailable lanes: two (error)");
    expect(prompt).toContain("contradiction matrix");
    expect(prompt).toContain("Do not decide by majority vote");
  });

  test("fails closed over the context limit without truncating or creating a summary child", async () => {
    const { state } = await fixtureState(cwd);
    const outputDir = path.join(home, "batches", state.batchId, "outputs", "lanes");
    const lanes = await Promise.all(
      state.lanes.map(async (lane) => {
        const outputPath = path.join(outputDir, lane.id, "answer.md");
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, `answer-${lane.id}`, "utf8");
        return { ...lane, status: "completed" as const, outputPath };
      }),
    );
    const completed = { ...state, status: "sealed" as const, lanes };
    await writeBatchState(completed);
    const assemblePrompt = vi.fn(async (options): Promise<BrowserPromptArtifacts> => ({
      markdown: options.prompt,
      composerText: options.prompt,
      estimatedInputTokens: 101,
      attachments: [],
      inlineFileCount: 0,
      tokenEstimateIncludesInlineFiles: false,
      attachmentsPolicy: "always",
      attachmentMode: "upload",
      fallback: null,
      bundled: null,
    }));
    const caught = await sealSynthesisInput(completed, { assemblePrompt, inputLimit: 100 }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(BatchSynthesisInputTooLargeError);
    expect((caught as Error).message).toContain("one=10");
    expect((caught as Error).message).toContain("No truncation or summary child was used");
    expect(assemblePrompt).toHaveBeenCalledTimes(1);
  });
});

async function fixtureState(cwd: string) {
  const loaded = fixtureLoaded(cwd);
  const state = await initializeBatchStore({
    loaded,
    batchId: "fixture-batch",
    sourceManifest: fixtureSource(cwd),
    effectiveMaxParallel: 2,
    effectiveMaxChildSessions: 3,
  });
  return { loaded, state };
}

function fixtureLoaded(cwd: string): LoadedBatchManifest {
  const manifest = {
    schemaVersion: "oracle.batch.v1" as const,
    slug: "fixture-batch",
    project: "fixture",
    objective: "Adjudicate.",
    lanes: [
      {
        id: "one",
        title: "One",
        mandate: "A",
        whyThisLane: "A",
        falsificationTarget: "A",
        prompt: "A",
        outputContract: ["A"],
      },
      {
        id: "two",
        title: "Two",
        mandate: "B",
        whyThisLane: "B",
        falsificationTarget: "B",
        prompt: "B",
        outputContract: ["B"],
      },
    ],
    synthesis: {
      id: "judge",
      title: "Judge",
      prompt: "Adjudicate.",
      requiredOutput: ["owner decisions"],
    },
  };
  return {
    sourcePath: path.join(cwd, "batch.json5"),
    sourceText: JSON.stringify(manifest),
    cwd,
    manifest,
    files: { sharedAuthority: [], lanes: { one: [], two: [] }, synthesis: [] },
  };
}

function fixtureSource(cwd: string): BatchSourceManifestV1 {
  return {
    schemaVersion: "oracle.batch.v1",
    batchId: "fixture-batch",
    capturedAt: new Date().toISOString(),
    cwd,
    git: {},
    manifestSha256: "c".repeat(64),
    files: [],
  };
}
