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

export async function captureBatchSourceManifest(
  loaded: LoadedBatchManifest,
  batchId: string,
): Promise<BatchSourceManifestV1> {
  const allFiles = new Set<string>(loaded.files.sharedAuthority);
  for (const files of Object.values(loaded.files.lanes)) {
    for (const file of files) allFiles.add(file);
  }
  for (const file of loaded.files.synthesis) allFiles.add(file);
  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId,
    capturedAt: new Date().toISOString(),
    cwd: loaded.cwd,
    git: await captureGitAuthority(loaded.cwd),
    manifestSha256: sha256Text(JSON.stringify(loaded.manifest)),
    files: await captureSourceFileIdentities([...allFiles], loaded.cwd),
  };
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

export async function detectBatchWorkspaceDrift(state: {
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
