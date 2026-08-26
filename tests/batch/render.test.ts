import { describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderBatch } from "../../src/batch/render.js";
import type { BatchManifestV1, BatchStateV1 } from "../../src/batch/types.js";

describe("batch rendering", () => {
  test("keeps raw answers hidden by default and refuses unreceipted raw output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-render-"));
    try {
      const one = path.join(root, "one.md");
      const two = path.join(root, "two.md");
      await Promise.all([
        fs.writeFile(one, "ANSWER ONE", "utf8"),
        fs.writeFile(two, "ANSWER TWO", "utf8"),
      ]);
      const manifest = fixtureManifest();
      const state = fixtureState(root, one, two);
      const summary = await renderBatch(manifest, state);
      expect(summary).not.toContain("ANSWER ONE");
      expect(summary).not.toContain("ANSWER TWO");
      await expect(renderBatch(manifest, state, { all: true })).rejects.toThrow(
        /no complete accepted answer receipt boundary/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an unknown requested lane", async () => {
    await expect(
      renderBatch(fixtureManifest(), fixtureState("/tmp", "/tmp/one", "/tmp/two"), {
        laneId: "missing",
      }),
    ).rejects.toThrow(/Unknown batch lane/u);
  });
});

function fixtureManifest(): BatchManifestV1 {
  return {
    schemaVersion: "oracle.batch.v1",
    slug: "fixture",
    project: "fixture",
    objective: "Render.",
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
  };
}

function fixtureState(cwd: string, one: string, two: string): BatchStateV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "oracle.batch.v1",
    batchId: "fixture",
    slug: "fixture",
    project: "fixture",
    objective: "Render.",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    cwd,
    sourceManifestSha256: "a".repeat(64),
    effectiveMaxParallel: 2,
    effectiveMaxChildSessions: 2,
    lanes: [
      {
        id: "one",
        role: "lane",
        required: true,
        status: "completed",
        outputPath: one,
        attempts: [],
      },
      {
        id: "two",
        role: "lane",
        required: true,
        status: "completed",
        outputPath: two,
        attempts: [],
      },
    ],
  };
}
