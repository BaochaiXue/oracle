import { createHash } from "node:crypto";
import path from "node:path";

export interface SealedBundleInput {
  path: string;
  bytes: Uint8Array;
}

export interface SealedBundleFileReceipt {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface SealedSourceBundle {
  bytes: Buffer;
  artifactSha256: string;
  sourceSetSha256: string;
  filename: string;
  files: SealedBundleFileReceipt[];
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function createSealedSourceBundle(inputs: readonly SealedBundleInput[]): SealedSourceBundle {
  if (inputs.length === 0) throw new Error("A sealed source bundle requires at least one file");
  const seen = new Set<string>();
  const normalized = inputs
    .map((input) => {
      const relativePath = normalizeBundlePath(input.path);
      if (seen.has(relativePath)) throw new Error(`Duplicate sealed bundle path: ${relativePath}`);
      seen.add(relativePath);
      let content: string;
      try {
        content = utf8.decode(input.bytes);
      } catch {
        throw new Error(`Sealed bundle input is not valid UTF-8 text: ${relativePath}`);
      }
      if (content.includes("\0")) {
        throw new Error(`Sealed bundle input contains binary NUL bytes: ${relativePath}`);
      }
      const text = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const bytes = Buffer.from(text, "utf8");
      return {
        path: relativePath,
        text,
        sizeBytes: bytes.byteLength,
        sha256: digest(bytes),
      };
    })
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
    );
  const sourceSetSha256 = digest(
    Buffer.from(
      normalized.map((file) => `${file.path}\0${file.sizeBytes}\0${file.sha256}`).join("\n"),
      "utf8",
    ),
  );
  const sections = normalized.map(
    (file) =>
      [
        "=== BEGIN FILE ===",
        `path: ${file.path}`,
        `size-bytes: ${file.sizeBytes}`,
        `sha256: ${file.sha256}`,
        "---",
        file.text,
        "=== END FILE ===",
      ].join("\n") + "\n",
  );
  const bytes = Buffer.from(
    [
      "ORACLE SEALED SOURCE BUNDLE v2",
      `source-set-sha256: ${sourceSetSha256}`,
      `file-count: ${normalized.length}`,
      "",
      ...sections,
    ].join("\n"),
    "utf8",
  );
  const artifactSha256 = digest(bytes);
  return {
    bytes,
    artifactSha256,
    sourceSetSha256,
    filename: `oracle-source-${artifactSha256.slice(0, 12)}.md`,
    files: normalized.map(({ path: filePath, sizeBytes, sha256 }) => ({
      path: filePath,
      sizeBytes,
      sha256,
    })),
  };
}

function normalizeBundlePath(value: string): string {
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Sealed bundle path contains unsupported characters: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized !== value
  ) {
    throw new Error(`Sealed bundle path must be a safe relative path: ${value}`);
  }
  return normalized;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
