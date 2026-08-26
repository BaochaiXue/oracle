import { describe, expect, test } from "vitest";
import {
  buildTextBundle,
  buildZipBundleManifest,
  createBundleIdentity,
  sanitizeBundleLabel,
  sanitizeBundleSegment,
  sha256,
} from "../../src/batch/bundleIdentity.js";

const files = [
  { relativePath: "src/b.ts", sizeBytes: 3, sha256: sha256("bbb") },
  { relativePath: "src/a.ts", sizeBytes: 3, sha256: sha256("aaa") },
];

describe("semantic bundle identity", () => {
  test("is deterministic and content-sensitive", () => {
    const first = createBundleIdentity({
      label: "espalier--constitution--sources",
      role: "sources",
      extension: "txt",
      files,
    }).identity;
    const second = createBundleIdentity({
      label: "espalier--constitution--sources",
      role: "sources",
      extension: "txt",
      files: files.map((_, index, entries) => entries[entries.length - index - 1]!),
    }).identity;
    const changed = createBundleIdentity({
      label: "espalier--constitution--sources",
      role: "sources",
      extension: "txt",
      files: [{ ...files[0]!, sha256: sha256("changed") }, files[1]!],
    }).identity;

    expect(first).toEqual(second);
    expect(first.bundleId).toMatch(/^[a-f0-9]{8}$/u);
    expect(first.filename).toBe(`espalier--constitution--sources--${first.bundleId}.txt`);
    expect(changed.bundleId).not.toBe(first.bundleId);
  });

  test("normalizes unicode and Windows-unsafe labels centrally", () => {
    expect(sanitizeBundleSegment("ＣＯＮ")).toBe("CON-item");
    expect(sanitizeBundleLabel(" Espalier / 认知__lane -- tribunal:*? ")).toBe(
      "Espalier-认知-lane--tribunal",
    );
    expect(sanitizeBundleSegment("..", "fallback")).toBe("fallback");
    expect(Array.from(sanitizeBundleLabel("segment".repeat(100))).length).toBeLessThanOrEqual(176);
  });

  test("binds lane and role changes into both the semantic name and digest", () => {
    const source = createBundleIdentity({
      label: "espalier--constitution--sources",
      role: "sources",
      extension: "zip",
      files,
    }).identity;
    const evidence = createBundleIdentity({
      label: "espalier--tribunal--evidence",
      role: "evidence",
      extension: "zip",
      files,
    }).identity;
    expect(evidence.bundleId).not.toBe(source.bundleId);
    expect(evidence.filename).toMatch(/^espalier--tribunal--evidence--/u);
  });

  test("adds a stable readable text header", () => {
    const result = buildTextBundle({
      label: "espalier--tribunal--screenshots",
      role: "screenshots",
      extension: "txt",
      files,
      body: "BODY\n",
      context: { batchId: "batch-1", laneId: "tribunal", authorityRevision: "Draft 0.2" },
    });
    expect(result.content).toContain("ORACLE INPUT BUNDLE");
    expect(result.content).toContain(`bundle_id: ${result.identity.bundleId}`);
    expect(result.content).toContain("batch_id: batch-1");
    expect(result.content).toContain("authority_revision: Draft 0.2");
    expect(result.content.endsWith("BODY\n")).toBe(true);
  });

  test("keeps ZIP outer name, root, and manifest label aligned", () => {
    const result = buildZipBundleManifest({
      label: "espalier--adjudication--lane-answers",
      role: "lane-answers",
      extension: "zip",
      files,
    });
    expect(result.identity.filename).toBe(`${result.root}.zip`);
    expect(JSON.parse(result.internalManifest).identity.label).toBe(result.identity.label);
  });
});
