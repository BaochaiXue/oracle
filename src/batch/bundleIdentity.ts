import { createHash } from "node:crypto";
import path from "node:path";
import type {
  BundleContext,
  BundleIdentity,
  BundleManifestV1,
  BundleRole,
  SourceFileIdentity,
} from "./types.js";
import { BUNDLE_SCHEMA_VERSION } from "./types.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_SEGMENT_LENGTH = 56;
const MAX_LABEL_LENGTH = 176;

export interface CreateBundleIdentityOptions {
  label?: string;
  project?: string;
  subject?: string;
  role: BundleRole;
  extension: "txt" | "zip";
  files: SourceFileIdentity[];
  instanceId: string;
}

export interface TextBundleResult {
  identity: BundleIdentity;
  manifest: BundleManifestV1;
  content: string;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeBundleSegment(input: string, fallback = "item"): string {
  let value = input.normalize("NFKC");
  value = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
  value = value.replace(/[\\/:*?"<>|]/gu, "-");
  value = value.replace(/[^\p{L}\p{N}.-]+/gu, "-");
  value = value.replace(/[\s_-]+/gu, "-").replace(/-{2,}/gu, "-");
  value = value.replace(/^[.\s-]+|[.\s-]+$/gu, "");
  if (!value || value === "." || value === "..") value = fallback;
  if (WINDOWS_RESERVED.test(value)) value = `${value}-item`;
  return (
    Array.from(value)
      .slice(0, MAX_SEGMENT_LENGTH)
      .join("")
      .replace(/[.\s-]+$/gu, "") || fallback
  );
}

export function sanitizeBundleLabel(input: string): string {
  const segments = input
    .normalize("NFKC")
    .split(/--+/gu)
    .map((segment, index) => sanitizeBundleSegment(segment, index === 0 ? "oracle" : "session"));
  let label = segments.join("--");
  if (Array.from(label).length > MAX_LABEL_LENGTH) {
    label = Array.from(label)
      .slice(0, MAX_LABEL_LENGTH)
      .join("")
      .replace(/[.\s-]+$/gu, "");
  }
  return label || "oracle--session--sources";
}

export function createBundleIdentity(options: CreateBundleIdentityOptions): {
  identity: BundleIdentity;
  manifest: BundleManifestV1;
} {
  const project = options.project ? sanitizeBundleSegment(options.project, "oracle") : undefined;
  const subject = options.subject ? sanitizeBundleSegment(options.subject, "session") : undefined;
  const fallbackLabel = [project ?? "oracle", subject ?? "session", options.role].join("--");
  const label = sanitizeBundleLabel(options.label?.trim() || fallbackLabel);
  const files = canonicalizeSourceFiles(options.files);
  const sourceSetBase = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    label,
    ...(project ? { project } : {}),
    ...(subject ? { subject } : {}),
    role: options.role,
    files,
  };
  const sourceSetSha256 = sha256(JSON.stringify(sourceSetBase));
  const instanceId = sanitizeBundleSegment(options.instanceId, "artifact");
  const manifest: BundleManifestV1 = { ...sourceSetBase, sourceSetSha256, instanceId };
  return {
    manifest,
    identity: {
      label,
      ...(project ? { project } : {}),
      ...(subject ? { subject } : {}),
      role: options.role,
      sourceSetSha256,
      instanceId,
      filename: `${label}--${instanceId}--${sourceSetSha256.slice(0, 8)}.${options.extension}`,
    },
  };
}

export function buildTextBundle(
  options: CreateBundleIdentityOptions & {
    body: string;
    context?: BundleContext;
    createdAt?: string;
  },
): TextBundleResult {
  const created = createBundleIdentity(options);
  const { manifest } = created;
  let identity = created.identity;
  const context = options.context ?? {};
  const header = [
    "ORACLE INPUT BUNDLE",
    `schema_version: ${BUNDLE_SCHEMA_VERSION}`,
    `source_set_sha256: ${identity.sourceSetSha256}`,
    `artifact_instance: ${identity.instanceId}`,
    `label: ${identity.label}`,
    `batch_id: ${context.batchId ?? "none"}`,
    `lane_id: ${context.laneId ?? "none"}`,
    `session_id: ${context.sessionId ?? "unassigned"}`,
    `created_at: ${options.createdAt ?? new Date().toISOString()}`,
    `authority_revision: ${context.authorityRevision ?? "unspecified"}`,
    `file_count: ${manifest.files.length}`,
    `manifest_sha256: ${sha256(JSON.stringify(manifest))}`,
    "",
  ].join("\n");
  const content = `${header}${options.body}`;
  identity = { ...identity, artifactSha256: sha256(content) };
  return { identity, manifest, content };
}

export function buildZipBundleManifest(
  options: CreateBundleIdentityOptions & {
    context?: BundleContext;
  },
): {
  identity: BundleIdentity;
  manifest: BundleManifestV1;
  root: string;
  internalManifest: string;
} {
  const { identity, manifest } = createBundleIdentity(options);
  const root = path.basename(identity.filename, ".zip");
  return {
    identity,
    manifest,
    root,
    internalManifest: JSON.stringify(
      {
        ...manifest,
        identity,
        context: options.context ?? {},
      },
      null,
      2,
    ),
  };
}

export function canonicalizeSourceFiles(files: SourceFileIdentity[]): SourceFileIdentity[] {
  return [...files]
    .map((file) => ({
      relativePath: file.relativePath.replace(/\\/gu, "/"),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function inferBundleRole(label: string | undefined): BundleRole {
  const normalized = label?.normalize("NFKC").toLowerCase() ?? "";
  const roles: BundleRole[] = [
    "sources",
    "evidence",
    "screenshots",
    "current-patch",
    "lane-answers",
  ];
  return roles.find((role) => normalized.split(/--+/gu).includes(role)) ?? "sources";
}
