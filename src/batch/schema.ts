import { z } from "zod";
import type { BatchManifestV1 } from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const NON_EMPTY = z.string().trim().min(1);

function hasUnsafePath(input: string): boolean {
  const candidate = input.startsWith("!") ? input.slice(1) : input;
  if (!candidate || candidate.includes("\0") || candidate.includes("\\")) return true;
  if (candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) return true;
  return candidate.split("/").some((segment) => segment === ".." || segment === "");
}

const safePath = NON_EMPTY.refine((value) => !hasUnsafePath(value), {
  message: "must be a relative path/glob without traversal, empty segments, or backslashes",
});
const idSchema = NON_EMPTY.regex(SAFE_ID, {
  message:
    "must start with a lowercase letter or digit and contain only lowercase letters, digits, _ or -",
});

const laneSchema = z
  .object({
    id: idSchema,
    title: NON_EMPTY,
    mandate: NON_EMPTY,
    whyThisLane: NON_EMPTY,
    falsificationTarget: NON_EMPTY,
    prompt: NON_EMPTY,
    files: z.array(safePath).min(1).optional(),
    bundleRole: z.enum(["sources", "evidence", "screenshots", "current-patch"]).optional(),
    outputContract: z.array(NON_EMPTY).min(1),
  })
  .strict();

const synthesisSchema = z
  .object({
    id: idSchema,
    title: NON_EMPTY,
    prompt: NON_EMPTY,
    files: z.array(safePath).min(1).optional(),
    requiredOutput: z.array(NON_EMPTY).min(1),
  })
  .strict();

const batchManifestSchema = z
  .object({
    schemaVersion: z.literal(BATCH_SCHEMA_VERSION),
    slug: idSchema,
    project: NON_EMPTY,
    objective: NON_EMPTY,
    cwd: safePath.optional(),
    sharedAuthority: z
      .object({
        revisionLabel: NON_EMPTY.optional(),
        files: z.array(safePath).min(1),
      })
      .strict()
      .optional(),
    policy: z
      .object({
        maxParallel: z.number().int().min(1).optional(),
        maxChildSessions: z.number().int().min(1).optional(),
        allowanceGate: z.literal("pause-batch").optional(),
        partialSynthesis: z.literal("owner-explicit").optional(),
        revealLaneAnswersBeforeBarrier: z.literal(false).optional(),
      })
      .strict()
      .optional(),
    lanes: z.array(laneSchema).min(2),
    synthesis: synthesisSchema.optional(),
  })
  .strict();

export interface ParseBatchManifestOptions {
  maxChildSessions?: number;
}

export function parseBatchManifest(
  input: unknown,
  options: ParseBatchManifestOptions = {},
): BatchManifestV1 {
  const parsed = batchManifestSchema.parse(input) as BatchManifestV1;
  const issues: z.core.$ZodIssue[] = [];
  const ids = new Map<string, number>();
  const prompts = new Map<string, number>();
  const signatures = new Map<string, number>();

  for (const [index, lane] of parsed.lanes.entries()) {
    if (ids.has(lane.id)) {
      issues.push(customIssue(["lanes", index, "id"], `duplicates lanes.${ids.get(lane.id)}.id`));
    } else {
      ids.set(lane.id, index);
    }
    const prompt = normalizeText(lane.prompt);
    if (prompts.has(prompt)) {
      issues.push(
        customIssue(
          ["lanes", index, "prompt"],
          `exactly duplicates lanes.${prompts.get(prompt)}.prompt after normalization`,
        ),
      );
    } else {
      prompts.set(prompt, index);
    }
    const files = [...(lane.files ?? [])].map((item) => normalizeText(item)).sort();
    const signature = JSON.stringify([prompt, files, normalizeText(lane.mandate)]);
    if (signatures.has(signature)) {
      issues.push(
        customIssue(
          ["lanes", index],
          `duplicates the prompt + sorted files + mandate combination from lanes.${signatures.get(signature)}`,
        ),
      );
    } else {
      signatures.set(signature, index);
    }
  }

  if (parsed.synthesis && ids.has(parsed.synthesis.id)) {
    issues.push(
      customIssue(["synthesis", "id"], `collides with lanes.${ids.get(parsed.synthesis.id)}.id`),
    );
  }

  const configuredCap = parsed.policy?.maxChildSessions ?? Number.POSITIVE_INFINITY;
  const localCap = options.maxChildSessions ?? Number.POSITIVE_INFINITY;
  const effectiveCap = Math.min(configuredCap, localCap);
  const childCount = parsed.lanes.length + (parsed.synthesis ? 1 : 0);
  if (childCount > effectiveCap) {
    issues.push(
      customIssue(
        ["policy", "maxChildSessions"],
        `batch declares ${childCount} child sessions but the effective cap is ${effectiveCap}`,
      ),
    );
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }
  return parsed;
}

export function formatBatchValidationError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function customIssue(path: PropertyKey[], message: string): z.core.$ZodIssue {
  return { code: "custom", path, message, input: undefined } as z.core.$ZodIssue;
}

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "manifest";
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : `${index > 0 ? "." : ""}${String(part)}`,
    )
    .join("");
}
