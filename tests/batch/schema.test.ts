import { describe, expect, test } from "vitest";
import { parseBatchManifest } from "../../src/batch/schema.js";

const manifest = () => ({
  schemaVersion: "oracle.batch.v1",
  slug: "espalier-tribunal",
  project: "espalier",
  objective: "Find the next bounded product experiment.",
  sharedAuthority: { files: ["docs/authority.md"] },
  policy: {
    maxParallel: 3,
    maxChildSessions: 4,
    allowanceGate: "pause-batch",
    partialSynthesis: "owner-explicit",
    revealLaneAnswersBeforeBarrier: false,
  },
  lanes: [
    {
      id: "constitution",
      title: "Constitution",
      mandate: "Establish the indispensable job.",
      whyThisLane: "Product boundaries are unresolved.",
      falsificationTarget: "The two scenes are unrelated tools.",
      prompt: "Review the product constitution.",
      files: ["evidence/product/**"],
      outputContract: ["boundaries"],
    },
    {
      id: "cognition",
      title: "Cognition",
      mandate: "Derive the information grammar.",
      whyThisLane: "Prior surfaces erased facts.",
      falsificationTarget: "Readability requires semantic erasure.",
      prompt: "Review the information grammar.",
      files: ["evidence/dense/**"],
      outputContract: ["attention rules"],
    },
    {
      id: "tribunal",
      title: "Tribunal",
      mandate: "Design a prototype that can die honestly.",
      whyThisLane: "Visual iteration has not proved necessity.",
      falsificationTarget: "Sparse fixtures keep the prototype alive.",
      prompt: "Review the failed prototypes.",
      files: ["evidence/screenshots/**"],
      outputContract: ["kill criteria"],
    },
  ],
  synthesis: {
    id: "adjudication",
    title: "Adjudication",
    prompt: "Preserve dissent and adjudicate contradictions.",
    requiredOutput: ["contradiction matrix"],
  },
});

describe("Batch Oracle manifest schema", () => {
  test("accepts a strict 3 + 1 manifest", () => {
    expect(parseBatchManifest(manifest(), { maxChildSessions: 5 }).lanes).toHaveLength(3);
  });

  test("requires at least two lanes", () => {
    const candidate = manifest();
    candidate.lanes = candidate.lanes.slice(0, 1);
    expect(() => parseBatchManifest(candidate)).toThrow(/lanes/u);
  });

  test("rejects duplicate lane ids and normalized prompts", () => {
    const candidate = manifest();
    candidate.lanes[1]!.id = "constitution";
    candidate.lanes[1]!.prompt = "  REVIEW   THE PRODUCT CONSTITUTION. ";
    expect(() => parseBatchManifest(candidate)).toThrow(/duplicates/u);
  });

  test("rejects unknown fields and synthesis id collisions", () => {
    const candidate = manifest() as ReturnType<typeof manifest> & { transport?: string };
    candidate.transport = "api";
    expect(() => parseBatchManifest(candidate)).toThrow(/Unrecognized key/u);
    delete candidate.transport;
    candidate.synthesis!.id = "constitution";
    expect(() => parseBatchManifest(candidate)).toThrow(/collides/u);
  });

  test("rejects traversal and unsupported schema versions", () => {
    const candidate = manifest();
    candidate.lanes[0]!.files = ["../private.txt"];
    expect(() => parseBatchManifest(candidate)).toThrow(/relative path/u);
    candidate.lanes[0]!.files = ["evidence/product/**"];
    candidate.schemaVersion = "oracle.batch.v2";
    expect(() => parseBatchManifest(candidate)).toThrow(/oracle\.batch\.v1/u);
  });

  test("enforces the effective child cap", () => {
    expect(() => parseBatchManifest(manifest(), { maxChildSessions: 3 })).toThrow(
      /effective cap is 3/u,
    );
  });
});
