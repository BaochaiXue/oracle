import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { captureBatchSourceManifest, loadBatchManifest } from "../../src/batch/manifest.js";
import { initializeBatchStore, getBatchPaths } from "../../src/batch/store.js";
import { loadSealedPromptArtifacts, sealFirstStageInputs } from "../../src/batch/seal.js";
import type { BrowserPromptArtifacts } from "../../src/browser/prompt.js";

describe("first-stage input sealing", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-seal-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-seal-cwd-"));
    setOracleHomeDirOverrideForTest(home);
    await fs.writeFile(path.join(cwd, "authority.md"), "frozen authority", "utf8");
    await fs.writeFile(path.join(cwd, "lane-a.md"), "A", "utf8");
    await fs.writeFile(path.join(cwd, "lane-b.md"), "B", "utf8");
    await fs.writeFile(path.join(cwd, "batch.json5"), JSON.stringify(manifest()), "utf8");
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("seals every lane before exposing final inputs and survives workspace mutation", async () => {
    const loaded = await loadBatchManifest("batch.json5", { cwd });
    const source = await captureBatchSourceManifest(loaded, "fixture-batch");
    await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: source,
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    const sealed = await sealFirstStageInputs(loaded, "fixture-batch");
    expect(sealed.map((entry) => entry.laneId)).toEqual(["one", "two"]);
    await fs.writeFile(path.join(cwd, "lane-a.md"), "MUTATED", "utf8");
    const reloaded = await loadSealedPromptArtifacts("fixture-batch", "one");
    const bundle = await fs.readFile(reloaded.artifacts.attachments[0]!.path, "utf8");
    expect(bundle).toContain("1 | A");
    expect(bundle).not.toContain("MUTATED");
    expect(bundle).toContain("batch_id: fixture-batch");
    expect(bundle).toContain("lane_id: one");
    expect(bundle).toContain("authority_revision: r1");
    expect(reloaded.artifacts.fallback).toBeNull();
    expect(reloaded.inputManifest.inputManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("one lane assembly failure leaves no dispatchable lane root", async () => {
    const loaded = await loadBatchManifest("batch.json5", { cwd });
    const source = await captureBatchSourceManifest(loaded, "fixture-batch");
    await initializeBatchStore({
      loaded,
      batchId: "fixture-batch",
      sourceManifest: source,
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    const assemble = vi.fn(async (options): Promise<BrowserPromptArtifacts> => {
      if (options.prompt.includes("Lane: two")) throw new Error("intentional seal failure");
      return fakeArtifacts(options.prompt);
    });
    await expect(
      sealFirstStageInputs(loaded, "fixture-batch", { assemblePrompt: assemble }),
    ).rejects.toThrow(/before any child session was created/u);
    await expect(
      fs.stat(path.join(getBatchPaths("fixture-batch").inputs, "lanes")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function manifest() {
  return {
    schemaVersion: "oracle.batch.v1",
    slug: "fixture-batch",
    project: "fixture",
    objective: "Test sealing.",
    sharedAuthority: { revisionLabel: "r1", files: ["authority.md"] },
    lanes: [
      {
        id: "one",
        title: "One",
        mandate: "A",
        whyThisLane: "A",
        falsificationTarget: "A",
        prompt: "Review A",
        files: ["lane-a.md"],
        outputContract: ["A"],
      },
      {
        id: "two",
        title: "Two",
        mandate: "B",
        whyThisLane: "B",
        falsificationTarget: "B",
        prompt: "Review B",
        files: ["lane-b.md"],
        outputContract: ["B"],
      },
    ],
  };
}

function fakeArtifacts(prompt: string): BrowserPromptArtifacts {
  return {
    markdown: prompt,
    composerText: prompt,
    estimatedInputTokens: 10,
    attachments: [],
    inlineFileCount: 0,
    tokenEstimateIncludesInlineFiles: false,
    attachmentsPolicy: "always",
    attachmentMode: "upload",
    fallback: null,
    bundled: null,
  };
}
