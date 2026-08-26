import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { loadBatchManifest, snapshotBatchSources } from "../../src/batch/manifest.js";
import { initializeBatchStore } from "../../src/batch/store.js";

describe("Batch Oracle manifest loading", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-manifest-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-manifest-home-"));
    setOracleHomeDirOverrideForTest(home);
    await fs.mkdir(path.join(cwd, "docs"));
    await fs.mkdir(path.join(cwd, "evidence"));
    await fs.writeFile(path.join(cwd, "docs", "authority.md"), "authority", "utf8");
    await fs.writeFile(path.join(cwd, "evidence", "a.md"), "A", "utf8");
    await fs.writeFile(path.join(cwd, "evidence", "b.md"), "B", "utf8");
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await Promise.all([
      fs.rm(cwd, { recursive: true, force: true }),
      fs.rm(home, { recursive: true, force: true }),
    ]);
  });

  test("parses JSON5, resolves files, and captures source identities", async () => {
    const manifestPath = path.join(cwd, "batch.json5");
    await fs.writeFile(
      manifestPath,
      `{
        schemaVersion: 'oracle.batch.v1',
        slug: 'test-batch',
        project: 'fixture',
        objective: 'Exercise sealing.',
        sharedAuthority: { files: ['docs/authority.md'] },
        lanes: [
          { id: 'one', title: 'One', mandate: 'Check A', whyThisLane: 'A matters', falsificationTarget: 'A fails', prompt: 'Review A', files: ['evidence/a.md'], outputContract: ['result'] },
          { id: 'two', title: 'Two', mandate: 'Check B', whyThisLane: 'B matters', falsificationTarget: 'B fails', prompt: 'Review B', files: ['evidence/b.md'], outputContract: ['result'] },
        ],
      }`,
      "utf8",
    );
    const loaded = await loadBatchManifest("batch.json5", { cwd, maxChildSessions: 5 });
    const realCwd = await fs.realpath(cwd);
    expect(loaded.files.sharedAuthority).toEqual([path.join(realCwd, "docs", "authority.md")]);
    expect(loaded.files.lanes.one).toEqual([path.join(realCwd, "evidence", "a.md")]);
    await initializeBatchStore({
      loaded,
      batchId: "test-batch",
      effectiveMaxParallel: 2,
      effectiveMaxChildSessions: 5,
    });
    const { manifest: source } = await snapshotBatchSources(loaded, "test-batch");
    expect(source.files.map((entry) => entry.relativePath)).toEqual([
      "docs/authority.md",
      "evidence/a.md",
      "evidence/b.md",
    ]);
    expect(source.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256))).toBe(true);
    expect(source.snapshotManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects a direct symlink escape", async () => {
    if (process.platform === "win32") return;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
      await fs.symlink(path.join(outside, "secret.md"), path.join(cwd, "evidence", "escape.md"));
      await fs.writeFile(
        path.join(cwd, "batch.json5"),
        JSON.stringify({
          schemaVersion: "oracle.batch.v1",
          slug: "test-batch",
          project: "fixture",
          objective: "Reject escapes.",
          lanes: [
            {
              id: "one",
              title: "One",
              mandate: "A",
              whyThisLane: "A",
              falsificationTarget: "A",
              prompt: "A",
              files: ["evidence/escape.md"],
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
        }),
        "utf8",
      );
      await expect(loadBatchManifest("batch.json5", { cwd })).rejects.toThrow(/escapes batch cwd/u);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
