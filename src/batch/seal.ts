import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunOracleOptions } from "../oracle/types.js";
import {
  assembleBrowserPrompt,
  cleanupGeneratedBrowserBundles,
  type BrowserPromptArtifacts,
} from "../browser/prompt.js";
import {
  captureSourceFileIdentities,
  readAndVerifyBatchSourceSnapshot,
  sha256Text,
} from "./manifest.js";
import { ensureOwnerDir, getBatchPaths, writeJsonAtomic, writeOwnerFileAtomic } from "./store.js";
import type {
  BatchInputManifestV1,
  BatchLaneSpec,
  LoadedBatchManifest,
  SealedAttachment,
  SealedBrowserPromptArtifacts,
} from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

export interface SealedLaneInput {
  laneId: string;
  inputDir: string;
  promptPath: string;
  artifactsPath: string;
  inputManifestPath: string;
  inputManifest: BatchInputManifestV1;
  artifacts: SealedBrowserPromptArtifacts;
}

export interface SealBatchDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
}

export async function sealFirstStageInputs(
  loaded: LoadedBatchManifest,
  batchId: string,
  deps: SealBatchDeps = {},
): Promise<SealedLaneInput[]> {
  const assemble = deps.assemblePrompt ?? assembleBrowserPrompt;
  const paths = getBatchPaths(batchId);
  const snapshotManifest = await readAndVerifyBatchSourceSnapshot(batchId);
  const snapshotPath = (relativePath: string) =>
    path.join(paths.sourceSnapshot, ...relativePath.split("/"));
  const attempts = await Promise.allSettled(
    loaded.manifest.lanes.map(async (lane) => {
      const sourceFiles = uniqueFiles([
        ...(snapshotManifest.sharedAuthority ?? []).map(snapshotPath),
        ...(snapshotManifest.lanes?.[lane.id] ?? []).map(snapshotPath),
      ]);
      const runOptions = buildLaneRunOptions(loaded, lane, sourceFiles, batchId);
      const artifacts = await assemble(runOptions, { cwd: loaded.cwd });
      return { lane, sourceFiles, artifacts };
    }),
  );
  const failures = attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(
      (entry): entry is { attempt: PromiseRejectedResult; index: number } =>
        entry.attempt.status === "rejected",
    );
  if (failures.length > 0) {
    await Promise.all(
      attempts
        .filter(
          (
            attempt,
          ): attempt is PromiseFulfilledResult<{
            lane: BatchLaneSpec;
            sourceFiles: string[];
            artifacts: BrowserPromptArtifacts;
          }> => attempt.status === "fulfilled",
        )
        .map((attempt) => cleanupGeneratedBrowserBundles(attempt.value.artifacts)),
    );
    const detail = failures
      .map(({ attempt, index }) => {
        const laneId = loaded.manifest.lanes[index]?.id ?? String(index);
        const message =
          attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason);
        return `${laneId}: ${message}`;
      })
      .join("; ");
    throw new Error(`Batch sealing failed before any child session was created: ${detail}`);
  }

  const successful = attempts as Array<
    PromiseFulfilledResult<{
      lane: BatchLaneSpec;
      sourceFiles: string[];
      artifacts: BrowserPromptArtifacts;
    }>
  >;
  const stagingRoot = path.join(paths.inputs, `.lanes-staging-${randomUUID()}`);
  await ensureOwnerDir(stagingRoot);
  try {
    const sealed = await Promise.all(
      successful.map(({ value }) =>
        persistSealedLane({
          batchId,
          cwd: loaded.cwd,
          sourceSnapshotRoot: paths.sourceSnapshot,
          sourceSnapshotManifestSha256: snapshotManifest.snapshotManifestSha256!,
          stagingRoot,
          lane: value.lane,
          sourceFiles: value.sourceFiles,
          artifacts: value.artifacts,
        }),
      ),
    );
    const finalRoot = path.join(paths.inputs, "lanes");
    await fs.rename(stagingRoot, finalRoot);
    const rebased = sealed.map((entry) => rebaseSealedLane(entry, stagingRoot, finalRoot));
    await Promise.all(
      rebased.map((entry) => writeJsonAtomic(entry.artifactsPath, entry.artifacts)),
    );
    return rebased;
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all(
      successful.map(({ value }) => cleanupGeneratedBrowserBundles(value.artifacts)),
    );
  }
}

export async function loadSealedPromptArtifacts(
  batchId: string,
  laneId: string,
  role: "lane" | "synthesis" = "lane",
): Promise<{ artifacts: SealedBrowserPromptArtifacts; inputManifest: BatchInputManifestV1 }> {
  const base =
    role === "lane"
      ? path.join(getBatchPaths(batchId).inputs, "lanes", laneId)
      : path.join(getBatchPaths(batchId).inputs, "synthesis");
  const artifacts = JSON.parse(
    await fs.readFile(path.join(base, "artifacts.json"), "utf8"),
  ) as SealedBrowserPromptArtifacts;
  const inputManifest = JSON.parse(
    await fs.readFile(path.join(base, "input-manifest.json"), "utf8"),
  ) as BatchInputManifestV1;
  await verifySealedPromptArtifacts(base, artifacts, inputManifest, {
    batchId,
    laneId,
    role,
  });
  return { artifacts, inputManifest };
}

export async function verifySealedPromptArtifacts(
  baseDir: string,
  artifacts: SealedBrowserPromptArtifacts,
  inputManifest: BatchInputManifestV1,
  expectedIdentity?: { batchId: string; laneId: string; role: "lane" | "synthesis" },
): Promise<void> {
  if (inputManifest.schemaVersion !== BATCH_SCHEMA_VERSION) {
    throw new Error(`Invalid sealed input schema for lane ${inputManifest.laneId}.`);
  }
  if (
    expectedIdentity &&
    (inputManifest.batchId !== expectedIdentity.batchId ||
      inputManifest.laneId !== expectedIdentity.laneId ||
      inputManifest.role !== expectedIdentity.role)
  ) {
    throw new Error(
      `Sealed input identity mismatch: expected ${expectedIdentity.batchId}/${expectedIdentity.role}/${expectedIdentity.laneId}.`,
    );
  }
  const { inputManifestSha256, ...manifestBase } = inputManifest;
  if (sha256Text(JSON.stringify(manifestBase)) !== inputManifestSha256) {
    throw new Error(`Sealed input manifest digest mismatch for lane ${inputManifest.laneId}.`);
  }
  const snapshot = inputManifest.sourceSnapshotManifestSha256
    ? await readAndVerifyBatchSourceSnapshot(inputManifest.batchId)
    : await verifyLegacyPreSnapshotInput(inputManifest);
  if (snapshot && snapshot.snapshotManifestSha256 !== inputManifest.sourceSnapshotManifestSha256) {
    throw new Error(`Sealed source snapshot mismatch for lane ${inputManifest.laneId}.`);
  }
  const prompt = await fs.readFile(path.join(baseDir, "prompt.txt"), "utf8");
  if (prompt !== artifacts.composerText || sha256Text(prompt) !== inputManifest.promptSha256) {
    throw new Error(`Sealed prompt file digest mismatch for lane ${inputManifest.laneId}.`);
  }
  if (sha256Text(artifacts.composerText) !== inputManifest.promptSha256) {
    throw new Error(`Sealed prompt digest mismatch for lane ${inputManifest.laneId}.`);
  }
  const expected = new Map(
    inputManifest.attachments.map((entry) => [entry.relativePath, entry] as const),
  );
  const seen = new Set<string>();
  for (const attachment of artifacts.attachments) {
    const relativePath = path.relative(baseDir, attachment.path).split(path.sep).join("/");
    if (relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      throw new Error(`Sealed attachment escapes its input root: ${attachment.path}`);
    }
    if (seen.has(relativePath)) {
      throw new Error(`Duplicate sealed attachment path: ${relativePath}`);
    }
    seen.add(relativePath);
    const identity = expected.get(relativePath);
    if (!identity) {
      throw new Error(`Sealed attachment is missing from the input manifest: ${relativePath}`);
    }
    const content = await fs.readFile(attachment.path);
    const actualSha = createHash("sha256").update(content).digest("hex");
    if (content.length !== identity.sizeBytes || actualSha !== identity.sha256) {
      throw new Error(
        `Sealed attachment digest mismatch for lane ${inputManifest.laneId}: ${relativePath}`,
      );
    }
  }
  if (seen.size !== expected.size) {
    throw new Error(`Sealed attachment set mismatch for lane ${inputManifest.laneId}.`);
  }
  if (inputManifest.role === "lane" && snapshot) {
    const declaredSources = new Map(snapshot.files.map((entry) => [entry.relativePath, entry]));
    for (const source of inputManifest.sourceFiles) {
      const declared = declaredSources.get(source.relativePath);
      if (
        !declared ||
        declared.sizeBytes !== source.sizeBytes ||
        declared.sha256 !== source.sha256
      ) {
        throw new Error(
          `Sealed source identity mismatch for lane ${inputManifest.laneId}: ${source.relativePath}`,
        );
      }
    }
    const expectedSources = new Set([
      ...(snapshot.sharedAuthority ?? []),
      ...(snapshot.lanes?.[inputManifest.laneId] ?? []),
    ]);
    const actualSources = new Set(inputManifest.sourceFiles.map((entry) => entry.relativePath));
    if (
      expectedSources.size !== actualSources.size ||
      [...expectedSources].some((relativePath) => !actualSources.has(relativePath))
    ) {
      throw new Error(`Sealed source set mismatch for lane ${inputManifest.laneId}.`);
    }
  }
}

async function verifyLegacyPreSnapshotInput(inputManifest: BatchInputManifestV1): Promise<null> {
  // Recovery-only compatibility for local batches created by the pre-snapshot
  // draft. New sealing always records a snapshot digest, and a new snapshot
  // manifest makes omission of that digest an integrity error.
  const source = JSON.parse(
    await fs.readFile(getBatchPaths(inputManifest.batchId).sourceManifestIdentity, "utf8"),
  ) as { schemaVersion?: string; batchId?: string; snapshotManifestSha256?: string };
  if (
    source.schemaVersion !== BATCH_SCHEMA_VERSION ||
    source.batchId !== inputManifest.batchId ||
    source.snapshotManifestSha256
  ) {
    throw new Error(`Sealed source snapshot digest is missing for lane ${inputManifest.laneId}.`);
  }
  return null;
}

export function buildLanePrompt(loaded: LoadedBatchManifest, lane: BatchLaneSpec): string {
  const authorityRevision = loaded.manifest.sharedAuthority?.revisionLabel ?? "unspecified";
  return [
    "BATCH ORACLE — BLIND FIRST PASS",
    `Project: ${loaded.manifest.project}`,
    `Batch objective: ${loaded.manifest.objective}`,
    `Lane: ${lane.id} — ${lane.title}`,
    `Canonical authority revision: ${authorityRevision}`,
    "",
    `Mandate: ${lane.mandate}`,
    `Why this lane exists: ${lane.whyThisLane}`,
    `Falsification target: ${lane.falsificationTarget}`,
    "",
    "Output contract:",
    ...lane.outputContract.map((item) => `- ${item}`),
    "",
    "This is an independent first-pass review. Do not assume sibling findings. Preserve uncertainty and identify reviewer-created assumptions.",
    "Arrival order is transport state, not epistemic priority.",
    "",
    "Task:",
    lane.prompt,
  ].join("\n");
}

function buildLaneRunOptions(
  loaded: LoadedBatchManifest,
  lane: BatchLaneSpec,
  files: string[],
  batchId: string,
): RunOracleOptions {
  const role = lane.bundleRole ?? "sources";
  return {
    prompt: buildLanePrompt(loaded, lane),
    model: "gpt-5-pro",
    file: files,
    slug: `${loaded.manifest.slug}-${lane.id}`,
    silent: true,
    search: false,
    browserAttachments: "always",
    browserInlineFiles: false,
    browserBundleFiles: true,
    browserBundleFormat: "auto",
    bundleLabel: `${loaded.manifest.project}--${lane.id}--${role}`,
    bundleContext: {
      batchId,
      laneId: lane.id,
      authorityRevision: loaded.manifest.sharedAuthority?.revisionLabel,
    },
  };
}

async function persistSealedLane(options: {
  batchId: string;
  cwd: string;
  sourceSnapshotRoot: string;
  sourceSnapshotManifestSha256: string;
  stagingRoot: string;
  lane: BatchLaneSpec;
  sourceFiles: string[];
  artifacts: BrowserPromptArtifacts;
}): Promise<SealedLaneInput> {
  const inputDir = path.join(options.stagingRoot, options.lane.id);
  const attachmentsDir = path.join(inputDir, "attachments");
  await ensureOwnerDir(attachmentsDir);
  const attachments: SealedAttachment[] = [];
  for (const attachment of options.artifacts.attachments) {
    const basename = path.basename(attachment.path);
    const target = path.join(attachmentsDir, basename);
    await writeOwnerFileAtomic(target, await fs.readFile(attachment.path));
    attachments.push({
      path: target,
      displayPath: target,
      sizeBytes: (await fs.stat(target)).size,
      generatedBundle: attachment.generatedBundle,
    });
  }
  const bundled = options.artifacts.bundled
    ? {
        ...options.artifacts.bundled,
        bundlePath:
          attachments.find((attachment) => attachment.generatedBundle)?.path ??
          options.artifacts.bundled.bundlePath,
      }
    : null;
  const sealedArtifacts: SealedBrowserPromptArtifacts = {
    markdown: options.artifacts.markdown,
    composerText: options.artifacts.composerText,
    estimatedInputTokens: options.artifacts.estimatedInputTokens,
    attachments,
    inlineFileCount: options.artifacts.inlineFileCount,
    tokenEstimateIncludesInlineFiles: options.artifacts.tokenEstimateIncludesInlineFiles,
    attachmentsPolicy: "always",
    attachmentMode: options.artifacts.attachmentMode === "bundle" ? "bundle" : "upload",
    fallback: null,
    bundled,
  };
  const promptPath = path.join(inputDir, "prompt.txt");
  const artifactsPath = path.join(inputDir, "artifacts.json");
  await writeOwnerFileAtomic(promptPath, sealedArtifacts.composerText);
  await writeJsonAtomic(artifactsPath, sealedArtifacts);
  const attachmentIdentities = await captureSourceFileIdentities(
    attachments.map((attachment) => attachment.path),
    inputDir,
  );
  const sourceIdentities = await captureSourceFileIdentities(
    options.sourceFiles,
    options.sourceSnapshotRoot,
  );
  const manifestWithoutDigest = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId: options.batchId,
    laneId: options.lane.id,
    role: "lane" as const,
    sealedAt: new Date().toISOString(),
    promptSha256: sha256Text(sealedArtifacts.composerText),
    sourceSnapshotManifestSha256: options.sourceSnapshotManifestSha256,
    attachments: attachmentIdentities,
    sourceFiles: sourceIdentities,
    estimatedInputTokens: sealedArtifacts.estimatedInputTokens,
  };
  const inputManifest: BatchInputManifestV1 = {
    ...manifestWithoutDigest,
    inputManifestSha256: sha256Text(JSON.stringify(manifestWithoutDigest)),
  };
  const inputManifestPath = path.join(inputDir, "input-manifest.json");
  await writeJsonAtomic(inputManifestPath, inputManifest);
  return {
    laneId: options.lane.id,
    inputDir,
    promptPath,
    artifactsPath,
    inputManifestPath,
    inputManifest,
    artifacts: sealedArtifacts,
  };
}

function rebaseSealedLane(
  sealed: SealedLaneInput,
  fromRoot: string,
  toRoot: string,
): SealedLaneInput {
  const rebase = (value: string) => path.join(toRoot, path.relative(fromRoot, value));
  return {
    ...sealed,
    inputDir: rebase(sealed.inputDir),
    promptPath: rebase(sealed.promptPath),
    artifactsPath: rebase(sealed.artifactsPath),
    inputManifestPath: rebase(sealed.inputManifestPath),
    artifacts: {
      ...sealed.artifacts,
      attachments: sealed.artifacts.attachments.map((attachment) => ({
        ...attachment,
        path: rebase(attachment.path),
        displayPath: rebase(attachment.displayPath),
      })),
      bundled: sealed.artifacts.bundled
        ? { ...sealed.artifacts.bundled, bundlePath: rebase(sealed.artifacts.bundled.bundlePath) }
        : null,
    },
  };
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files)].sort();
}
