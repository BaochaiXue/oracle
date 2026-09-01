import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assembleBrowserPrompt, cleanupGeneratedBrowserBundles } from "../browser/prompt.js";
import { MODEL_CONFIGS } from "../oracle/config.js";
import type { RunOracleOptions } from "../oracle/types.js";
import { readVerifiedBatchAnswer } from "./answers.js";
import {
  captureSourceFileIdentities,
  readAndVerifyBatchSourceSnapshot,
  sha256Text,
} from "./manifest.js";
import {
  ensureOwnerDir,
  getBatchPaths,
  readNormalizedBatchManifest,
  writeJsonAtomic,
  writeOwnerFileAtomic,
} from "./store.js";
import type {
  BatchInputManifestV1,
  BatchStateV1,
  SealedAttachment,
  SealedBrowserPromptArtifacts,
} from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

export interface SynthesisInputSize {
  laneId: string;
  sizeBytes: number;
}

export class BatchSynthesisInputTooLargeError extends Error {
  readonly code = "batch-synthesis-input-too-large";
  constructor(
    readonly estimatedInputTokens: number,
    readonly inputLimit: number,
    readonly answers: SynthesisInputSize[],
  ) {
    super(
      `Synthesis input is ~${estimatedInputTokens.toLocaleString()} tokens, above the ${inputLimit.toLocaleString()} token limit. Per-lane answer bytes: ${answers.map((entry) => `${entry.laneId}=${entry.sizeBytes}`).join(", ")}. No truncation or summary child was used.`,
    );
  }
}

export interface SealSynthesisDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
  inputLimit?: number;
}

export async function sealSynthesisInput(
  state: BatchStateV1,
  deps: SealSynthesisDeps = {},
): Promise<{ artifacts: SealedBrowserPromptArtifacts; inputManifest: BatchInputManifestV1 }> {
  if (!state.synthesis) throw new Error(`Batch ${state.batchId} has no synthesis stage.`);
  const manifest = await readNormalizedBatchManifest(state.batchId);
  if (!manifest.synthesis)
    throw new Error(`Batch ${state.batchId} has no synthesis specification.`);
  const paths = getBatchPaths(state.batchId);
  const snapshot = await readAndVerifyBatchSourceSnapshot(state.batchId);
  const synthesisDir = path.join(paths.inputs, "synthesis");
  const sourceDir = path.join(synthesisDir, "source");
  await ensureOwnerDir(sourceDir);
  await writeJsonAtomic(path.join(sourceDir, "batch-manifest.json"), manifest);
  await writeOwnerFileAtomic(
    path.join(sourceDir, "source-manifest.json"),
    await fs.readFile(paths.sourceManifestIdentity),
  );
  const answerSizes: SynthesisInputSize[] = [];
  const sourceFiles: string[] = [
    path.join(sourceDir, "batch-manifest.json"),
    path.join(sourceDir, "source-manifest.json"),
  ];
  const authorityDir = path.join(sourceDir, "shared-authority");
  for (const relativePath of snapshot.sharedAuthority ?? []) {
    const source = path.join(paths.sourceSnapshot, ...relativePath.split("/"));
    const target = path.join(authorityDir, ...relativePath.split("/"));
    await writeOwnerFileAtomic(target, await fs.readFile(source));
    sourceFiles.push(target);
  }
  const synthesisExtrasDir = path.join(sourceDir, "synthesis-extra");
  for (const relativePath of snapshot.synthesis ?? []) {
    const source = path.join(paths.sourceSnapshot, ...relativePath.split("/"));
    const target = path.join(synthesisExtrasDir, ...relativePath.split("/"));
    await writeOwnerFileAtomic(target, await fs.readFile(source));
    sourceFiles.push(target);
  }
  const laneStatus = state.lanes.map((lane) => ({
    id: lane.id,
    status: lane.status,
    jobId: lane.jobId,
    sessionId: lane.sessionId,
    inputManifestSha256: lane.inputManifestSha256,
    outputSha256: lane.outputSha256,
    acceptedMissing: lane.acceptedMissing === true,
    error: lane.lastError,
  }));
  const laneStatusPath = path.join(sourceDir, "lane-status.json");
  await writeJsonAtomic(laneStatusPath, laneStatus);
  sourceFiles.push(laneStatusPath);
  const answersDir = path.join(sourceDir, "lane-answers");
  await ensureOwnerDir(answersDir);
  for (const lane of state.lanes) {
    if (lane.status !== "completed") continue;
    const verified = await readVerifiedBatchAnswer(state.batchId, lane);
    const laneDir = path.join(answersDir, lane.id);
    const answerPath = path.join(laneDir, "answer.md");
    const receiptPath = path.join(laneDir, "answer-receipt.json");
    const inputManifestPath = path.join(laneDir, "input-manifest.json");
    await Promise.all([
      writeOwnerFileAtomic(answerPath, verified.answer),
      writeOwnerFileAtomic(receiptPath, verified.receiptBytes),
      writeOwnerFileAtomic(inputManifestPath, verified.inputManifestBytes),
    ]);
    sourceFiles.push(answerPath, receiptPath, inputManifestPath);
    answerSizes.push({ laneId: lane.id, sizeBytes: verified.answer.length });
  }

  const prompt = buildSynthesisPrompt(manifest, state);
  const runOptions: RunOracleOptions = {
    prompt,
    model: "gpt-5-pro",
    file: sourceFiles,
    slug: `${state.slug}-${manifest.synthesis.id}`,
    silent: true,
    search: false,
    browserAttachments: "always",
    browserInlineFiles: false,
    browserBundleFiles: true,
    browserBundleFormat: "auto",
    bundleLabel: `${manifest.project}--${manifest.synthesis.id}--lane-answers`,
    bundleContext: {
      batchId: state.batchId,
      laneId: manifest.synthesis.id,
      authorityRevision: manifest.sharedAuthority?.revisionLabel,
    },
  };
  const assembled = await (deps.assemblePrompt ?? assembleBrowserPrompt)(runOptions, {
    cwd: paths.root,
  });
  const inputLimit = deps.inputLimit ?? MODEL_CONFIGS["gpt-5-pro"].inputLimit ?? 196_000;
  if (assembled.estimatedInputTokens > inputLimit) {
    await cleanupGeneratedBrowserBundles(assembled);
    throw new BatchSynthesisInputTooLargeError(
      assembled.estimatedInputTokens,
      inputLimit,
      answerSizes,
    );
  }
  try {
    const attachmentsDir = path.join(synthesisDir, "attachments");
    await ensureOwnerDir(attachmentsDir);
    const attachments: SealedAttachment[] = [];
    for (const attachment of assembled.attachments) {
      const target = path.join(attachmentsDir, path.basename(attachment.path));
      const content = await fs.readFile(attachment.path);
      await writeOwnerFileAtomic(target, content);
      attachments.push({
        path: target,
        displayPath: target,
        sizeBytes: content.length,
        generatedBundle: attachment.generatedBundle,
      });
    }
    const artifacts: SealedBrowserPromptArtifacts = {
      markdown: assembled.markdown,
      composerText: assembled.composerText,
      estimatedInputTokens: assembled.estimatedInputTokens,
      attachments,
      inlineFileCount: assembled.inlineFileCount,
      tokenEstimateIncludesInlineFiles: assembled.tokenEstimateIncludesInlineFiles,
      attachmentsPolicy: "always",
      attachmentMode: assembled.attachmentMode === "bundle" ? "bundle" : "upload",
      fallback: null,
      bundled: assembled.bundled
        ? {
            ...assembled.bundled,
            bundlePath:
              attachments.find((attachment) => attachment.generatedBundle)?.path ??
              assembled.bundled.bundlePath,
          }
        : null,
    };
    await writeOwnerFileAtomic(path.join(synthesisDir, "prompt.txt"), artifacts.composerText);
    await writeJsonAtomic(path.join(synthesisDir, "artifacts.json"), artifacts);
    const attachmentIdentities = await captureSourceFileIdentities(
      attachments.map((attachment) => attachment.path),
      synthesisDir,
    );
    const sourceIdentities = await captureSourceFileIdentities(sourceFiles, paths.root);
    const base = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId: state.batchId,
      laneId: manifest.synthesis.id,
      role: "synthesis" as const,
      sealedAt: new Date().toISOString(),
      promptSha256: sha256Text(artifacts.composerText),
      sourceSnapshotManifestSha256: snapshot.snapshotManifestSha256!,
      attachments: attachmentIdentities,
      sourceFiles: sourceIdentities,
      estimatedInputTokens: artifacts.estimatedInputTokens,
    };
    const inputManifest: BatchInputManifestV1 = {
      ...base,
      inputManifestSha256: sha256Text(JSON.stringify(base)),
    };
    await writeJsonAtomic(path.join(synthesisDir, "input-manifest.json"), inputManifest);
    return { artifacts, inputManifest };
  } finally {
    await cleanupGeneratedBrowserBundles(assembled);
  }
}

export function buildSynthesisPrompt(
  manifest: Awaited<ReturnType<typeof readNormalizedBatchManifest>>,
  state: BatchStateV1,
): string {
  if (!manifest.synthesis) throw new Error("Missing synthesis specification.");
  const missing = state.lanes
    .filter((lane) => lane.status !== "completed")
    .map((lane) => `${lane.id} (${lane.status})`);
  const required = [
    "supported agreement",
    "suspicious or unsupported agreement",
    "contradiction matrix",
    "conflicts resolvable from canonical authority",
    "reviewer-created assumptions",
    "owner-pending value or priority decisions",
    "next bounded experiment",
    "five-second tests",
    "kill criteria",
    "effect of missing lanes on conclusion strength",
    ...manifest.synthesis.requiredOutput,
  ];
  return [
    "BATCH ORACLE — CONTRADICTION-FIRST SYNTHESIS",
    `Project: ${manifest.project}`,
    `Objective: ${manifest.objective}`,
    `Synthesis: ${manifest.synthesis.id} — ${manifest.synthesis.title}`,
    `Missing or unavailable lanes: ${missing.length > 0 ? missing.join(", ") : "none"}`,
    "",
    "The attached sealed bundle contains the normalized batch manifest, authority provenance, manifest-ordered lane status, every available raw lane answer, and synthesis-specific files.",
    "Raw child answers are evidence and must remain distinct. Preserve dissent. Do not decide by majority vote, confidence averaging, or arrival order.",
    "",
    "Required output:",
    ...[...new Set(required)].map((item) => `- ${item}`),
    "",
    "Task:",
    manifest.synthesis.prompt,
  ].join("\n");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
