import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { JOB_SCHEMA_VERSION, type JobSpec, type ObjectRef } from "../../oracle-kernel/src/index.js";
import type { OracleClient } from "./client.js";
import type { ClientAdmission } from "./types.js";

export interface OracleJobInvocation {
  requestId: string;
  idempotency: JobSpec["idempotency"];
  owner: JobSpec["owner"];
  promptBytes: Uint8Array;
  bundleBytes?: Uint8Array;
  intentDirectory: string;
  maxCaptureMs?: number;
  lineage?: JobSpec["lineage"];
  admissionKind?: "job" | "canary";
}

export interface OracleJobAdmission {
  admission: ClientAdmission;
  spec: JobSpec;
  intentPath: string;
  admissionPath: string;
}

type InvocationTransport = Pick<OracleClient, "putObject" | "admitJob" | "admitCanary">;

interface ClientIntentReceipt {
  schemaVersion: "oracle.client-intent.v2";
  admissionFingerprint: string;
  requestId: string;
  idempotency: JobSpec["idempotency"];
  owner: JobSpec["owner"];
  promptSha256: string;
  bundleSha256: string | null;
  createdAt: string;
}

interface ClientAdmissionReceipt {
  schemaVersion: "oracle.client-admission.v2";
  admissionFingerprint: string;
  jobId: string;
  admittedAt: string;
}

export async function admitOracleJob(
  client: InvocationTransport,
  invocation: OracleJobInvocation,
): Promise<OracleJobAdmission> {
  const promptSha256 = digest(invocation.promptBytes);
  const bundleSha256 = invocation.bundleBytes ? digest(invocation.bundleBytes) : undefined;
  const maxCaptureMs = invocation.maxCaptureMs ?? 30 * 60_000;
  const admissionKind = invocation.admissionKind ?? "job";
  safeRequestId(invocation.requestId);
  const identityDigest = digest(
    Buffer.from(`${invocation.idempotency.scope}\0${invocation.idempotency.key}`, "utf8"),
  );
  const intentPath = path.join(invocation.intentDirectory, `intent-${identityDigest}.json`);
  const admissionPath = path.join(
    invocation.intentDirectory,
    `intent-${identityDigest}.admission.json`,
  );
  const admissionFingerprint = digest(
    Buffer.from(
      canonicalJson({
        requestId: invocation.requestId,
        idempotency: invocation.idempotency,
        owner: invocation.owner,
        promptSha256,
        bundleSha256: bundleSha256 ?? null,
        admissionKind,
        route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
        policy: {
          maxCaptureMs,
          allowAutomaticCaptureRecovery: true,
          allowAutomaticResend: false,
          requireCommittedBundleEvidence: bundleSha256 !== undefined,
        },
        lineage: invocation.lineage ?? null,
      }),
      "utf8",
    ),
  );
  loadOrCreateIntent(intentPath, {
    schemaVersion: "oracle.client-intent.v2",
    admissionFingerprint,
    requestId: invocation.requestId,
    idempotency: invocation.idempotency,
    owner: invocation.owner,
    promptSha256,
    bundleSha256: bundleSha256 ?? null,
    createdAt: new Date().toISOString(),
  });
  const prompt = await client.putObject(invocation.promptBytes, {
    mediaType: "text/plain",
    objectClass: "prompt",
  });
  const bundle = invocation.bundleBytes
    ? await client.putObject(invocation.bundleBytes, {
        mediaType: "text/markdown",
        objectClass: "bundle",
      })
    : undefined;
  const spec: JobSpec = {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: invocation.requestId,
    idempotency: invocation.idempotency,
    owner: invocation.owner,
    input: {
      prompt: prompt as Omit<ObjectRef, "objectClass"> & { objectClass: "prompt" },
      promptSha256,
      ...(bundle && bundleSha256
        ? {
            bundle: bundle as Omit<ObjectRef, "objectClass"> & { objectClass: "bundle" },
            bundleSha256,
          }
        : {}),
    },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    policy: {
      maxCaptureMs,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: bundle !== undefined,
    },
    ...(invocation.lineage ? { lineage: invocation.lineage } : {}),
  };
  const admission =
    admissionKind === "canary" ? await client.admitCanary(spec) : await client.admitJob(spec);
  loadOrCreateAdmission(admissionPath, {
    schemaVersion: "oracle.client-admission.v2",
    admissionFingerprint,
    jobId: admission.job.id,
    admittedAt: new Date().toISOString(),
  });
  return { admission, spec: admission.job.spec, intentPath, admissionPath };
}

function loadOrCreateIntent(
  intentPath: string,
  expected: ClientIntentReceipt,
): ClientIntentReceipt {
  if (writeNewPrivateJson(intentPath, expected)) return expected;
  const existing = JSON.parse(readFileSync(intentPath, "utf8")) as ClientIntentReceipt;
  if (
    existing.schemaVersion !== expected.schemaVersion ||
    existing.admissionFingerprint !== expected.admissionFingerprint ||
    existing.requestId !== expected.requestId ||
    existing.idempotency.scope !== expected.idempotency.scope ||
    existing.idempotency.key !== expected.idempotency.key ||
    JSON.stringify(existing.owner) !== JSON.stringify(expected.owner) ||
    existing.promptSha256 !== expected.promptSha256 ||
    existing.bundleSha256 !== expected.bundleSha256
  ) {
    throw new Error(`Oracle client intent identity mismatch for ${expected.requestId}`);
  }
  return existing;
}

function loadOrCreateAdmission(
  admissionPath: string,
  expected: ClientAdmissionReceipt,
): ClientAdmissionReceipt {
  if (writeNewPrivateJson(admissionPath, expected)) return expected;
  const existing = JSON.parse(readFileSync(admissionPath, "utf8")) as ClientAdmissionReceipt;
  if (
    existing.schemaVersion !== expected.schemaVersion ||
    existing.admissionFingerprint !== expected.admissionFingerprint ||
    existing.jobId !== expected.jobId
  ) {
    throw new Error(`Oracle client admission identity mismatch for ${expected.jobId}`);
  }
  return existing;
}

function writeNewPrivateJson(destination: string, value: unknown): boolean {
  const directory = path.dirname(destination);
  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (!directoryExisted) fsyncDirectory(path.dirname(directory));
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (!isFileExists(error)) throw error;
      return false;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    fsyncDirectory(directory);
    return true;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isFileExists(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function safeRequestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Unsafe Oracle request ID: ${value}`);
  }
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
