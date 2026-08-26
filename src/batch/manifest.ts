import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSON5 from "json5";
import { readFiles } from "../oracle/files.js";
import type {
  BatchManifestV1,
  BatchSourceManifestV1,
  GitAuthoritySnapshot,
  LoadedBatchManifest,
  ResolvedBatchFiles,
  SourceFileIdentity,
} from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";
import { formatBatchValidationError, parseBatchManifest } from "./schema.js";
import { getBatchPaths, writeJsonAtomic, writeOwnerFileAtomic } from "./store.js";

const execFileAsync = promisify(execFile);

export interface LoadBatchManifestOptions {
  cwd?: string;
  maxChildSessions?: number;
}

export async function loadBatchManifest(
  manifestPath: string,
  options: LoadBatchManifestOptions = {},
): Promise<LoadedBatchManifest> {
  const invocationCwd = path.resolve(options.cwd ?? process.cwd());
  const sourcePath = path.resolve(invocationCwd, manifestPath);
  const sourceText = await fs.readFile(sourcePath, "utf8").catch((error) => {
    throw new Error(
      `manifest: unable to read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let raw: unknown;
  try {
    raw = JSON5.parse(sourceText);
  } catch (error) {
    throw new Error(
      `manifest: invalid JSON/JSON5: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let manifest: BatchManifestV1;
  try {
    manifest = parseBatchManifest(raw, { maxChildSessions: options.maxChildSessions });
  } catch (error) {
    throw new Error(formatBatchValidationError(error));
  }
  const cwd = path.resolve(invocationCwd, manifest.cwd ?? ".");
  const cwdStats = await fs.stat(cwd).catch(() => null);
  if (!cwdStats?.isDirectory()) {
    throw new Error(`cwd: not a directory: ${cwd}`);
  }
  const realCwd = await fs.realpath(cwd);
  const sharedAuthority = await resolveFileList(
    manifest.sharedAuthority?.files ?? [],
    realCwd,
    "sharedAuthority.files",
  );
  const lanes: Record<string, string[]> = {};
  for (const [index, lane] of manifest.lanes.entries()) {
    lanes[lane.id] = await resolveFileList(lane.files ?? [], realCwd, `lanes[${index}].files`);
  }
  const synthesis = await resolveFileList(
    manifest.synthesis?.files ?? [],
    realCwd,
    "synthesis.files",
  );
  const files: ResolvedBatchFiles = { sharedAuthority, lanes, synthesis };
  return { sourcePath, sourceText, cwd: realCwd, manifest, files };
}

/**
 * Copies every admitted source exactly once, hashes the copied bytes, and only
 * then publishes the complete snapshot directory. Lane assembly must consume
 * these paths rather than re-reading the mutable workspace.
 */
export async function snapshotBatchSources(
  loaded: LoadedBatchManifest,
  batchId: string,
): Promise<{ manifest: BatchSourceManifestV1; files: ResolvedBatchFiles }> {
  const paths = getBatchPaths(batchId);
  const realCwd = await fs.realpath(loaded.cwd);
  const staging = path.join(paths.inputs, `.source-snapshot-staging-${process.pid}-${Date.now()}`);
  const published = paths.sourceSnapshot;
  const allFiles = [
    ...loaded.files.sharedAuthority,
    ...Object.values(loaded.files.lanes).flat(),
    ...loaded.files.synthesis,
  ];
  const unique = [...new Set(allFiles)].sort();
  const copied = new Map<string, { snapshotPath: string; identity: SourceFileIdentity }>();
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const source of unique) {
      const realSource = await fs.realpath(source);
      assertWithinRoot(realCwd, realSource, source);
      const relativePath = toPosix(path.relative(realCwd, realSource));
      const content = await fs.readFile(realSource);
      const target = path.join(staging, ...relativePath.split("/"));
      await writeOwnerFileAtomic(target, content);
      copied.set(realSource, {
        snapshotPath: target,
        identity: {
          relativePath,
          sizeBytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      });
      copied.set(source, copied.get(realSource)!);
    }
    const membership = (files: string[]) =>
      files.map((file) => copied.get(file)?.identity.relativePath).filter(Boolean) as string[];
    const manifestBase = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId,
      capturedAt: new Date().toISOString(),
      cwd: realCwd,
      git: await captureGitAuthority(realCwd),
      manifestSha256: sha256Text(JSON.stringify(loaded.manifest)),
      files: [
        ...new Map(
          [...copied.values()].map(
            (entry) => [entry.identity.relativePath, entry.identity] as const,
          ),
        ).values(),
      ].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      sharedAuthority: membership(loaded.files.sharedAuthority),
      lanes: Object.fromEntries(
        Object.entries(loaded.files.lanes).map(([laneId, files]) => [laneId, membership(files)]),
      ),
      synthesis: membership(loaded.files.synthesis),
    };
    const manifest: BatchSourceManifestV1 = {
      ...manifestBase,
      snapshotManifestSha256: sha256Text(JSON.stringify(manifestBase)),
    };
    await writeJsonAtomic(path.join(staging, "snapshot-manifest.json"), manifest);
    await fs.rename(staging, published);
    await writeJsonAtomic(paths.sourceManifestIdentity, manifest);
    const resolveSnapshot = (relativePaths: string[] = []) =>
      relativePaths.map((relativePath) => path.join(published, ...relativePath.split("/")));
    return {
      manifest,
      files: {
        sharedAuthority: resolveSnapshot(manifest.sharedAuthority),
        lanes: Object.fromEntries(
          Object.entries(manifest.lanes ?? {}).map(([laneId, files]) => [
            laneId,
            resolveSnapshot(files),
          ]),
        ),
        synthesis: resolveSnapshot(manifest.synthesis),
      },
    };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readAndVerifyBatchSourceSnapshot(
  batchId: string,
): Promise<BatchSourceManifestV1> {
  const paths = getBatchPaths(batchId);
  const manifest = JSON.parse(
    await fs.readFile(paths.sourceManifestIdentity, "utf8"),
  ) as BatchSourceManifestV1;
  const { snapshotManifestSha256, ...base } = manifest;
  if (
    manifest.schemaVersion !== BATCH_SCHEMA_VERSION ||
    manifest.batchId !== batchId ||
    !snapshotManifestSha256 ||
    sha256Text(JSON.stringify(base)) !== snapshotManifestSha256
  ) {
    throw new Error(`Batch ${batchId} source snapshot manifest identity mismatch.`);
  }
  const sealedCopy = JSON.parse(
    await fs.readFile(path.join(paths.sourceSnapshot, "snapshot-manifest.json"), "utf8"),
  ) as BatchSourceManifestV1;
  if (JSON.stringify(sealedCopy) !== JSON.stringify(manifest)) {
    throw new Error(`Batch ${batchId} published source snapshot manifest differs from its seal.`);
  }
  const declared = new Set(manifest.files.map((entry) => entry.relativePath));
  for (const relativePath of [
    ...(manifest.sharedAuthority ?? []),
    ...Object.values(manifest.lanes ?? {}).flat(),
    ...(manifest.synthesis ?? []),
  ]) {
    if (!declared.has(relativePath)) {
      throw new Error(`Batch ${batchId} snapshot membership is undeclared: ${relativePath}`);
    }
  }
  for (const identity of manifest.files) {
    const target = safeSnapshotPath(paths.sourceSnapshot, identity.relativePath);
    const content = await fs.readFile(target);
    if (
      content.length !== identity.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== identity.sha256
    ) {
      throw new Error(`Batch ${batchId} source snapshot digest mismatch: ${identity.relativePath}`);
    }
  }
  const actualFiles = (await listFilesRecursive(paths.sourceSnapshot))
    .map((target) => toPosix(path.relative(paths.sourceSnapshot, target)))
    .filter((relativePath) => relativePath !== "snapshot-manifest.json")
    .sort();
  const expectedFiles = manifest.files.map((entry) => entry.relativePath).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Batch ${batchId} source snapshot contains an undeclared or missing file.`);
  }
  return manifest;
}

export async function captureSourceFileIdentities(
  files: string[],
  cwd: string,
): Promise<SourceFileIdentity[]> {
  const realCwd = await fs.realpath(cwd);
  const identities = await Promise.all(
    files.map(async (file) => {
      const realPath = await fs.realpath(file);
      assertWithinRoot(realCwd, realPath, path.relative(realCwd, realPath) || file);
      const content = await fs.readFile(realPath);
      return {
        relativePath: toPosix(path.relative(realCwd, realPath) || path.basename(realPath)),
        sizeBytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  return identities.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function captureGitAuthority(cwd: string): Promise<GitAuthoritySnapshot> {
  const head = await gitValue(cwd, ["rev-parse", "HEAD"]);
  if (!head) return {};
  const branch = (await gitValue(cwd, ["branch", "--show-current"])) || undefined;
  const status = await gitValue(cwd, ["status", "--porcelain"]);
  return { head, branch, dirty: Boolean(status) };
}

export async function detectAdmittedSourceDrift(state: {
  cwd: string;
  sourceManifestPath: string;
}): Promise<boolean> {
  let source: BatchSourceManifestV1;
  try {
    source = JSON.parse(
      await fs.readFile(state.sourceManifestPath, "utf8"),
    ) as BatchSourceManifestV1;
  } catch {
    return true;
  }
  for (const identity of source.files) {
    try {
      const target = path.join(state.cwd, identity.relativePath);
      const realTarget = await fs.realpath(target);
      assertWithinRoot(state.cwd, realTarget, identity.relativePath);
      const content = await fs.readFile(realTarget);
      if (
        content.length !== identity.sizeBytes ||
        createHash("sha256").update(content).digest("hex") !== identity.sha256
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveFileList(
  patterns: string[],
  cwd: string,
  fieldPath: string,
): Promise<string[]> {
  if (patterns.length === 0) return [];
  let files;
  try {
    files = await readFiles(patterns, { cwd, maxFileSizeBytes: 0, readContents: false });
  } catch (error) {
    throw new Error(`${fieldPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const realFiles = await Promise.all(
    files.map(async (file) => {
      const realPath = await fs.realpath(file.path);
      assertWithinRoot(cwd, realPath, fieldPath);
      return realPath;
    }),
  );
  return [...new Set(realFiles)].sort();
}

function assertWithinRoot(root: string, candidate: string, fieldPath: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`${fieldPath}: resolved path escapes batch cwd: ${candidate}`);
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function safeSnapshotPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe source snapshot path: ${relativePath}`);
  }
  return target;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
