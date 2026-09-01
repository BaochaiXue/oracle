#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  launchOracleBrowserRuntime,
  readRuntimeCertification,
  writePrivateJson,
} from "../packages/oracle-browser-runtime/src/index.js";
import { ChatGptAdapter } from "../packages/chatgpt-adapter/src/index.js";
import { OracleClient } from "../packages/oracle-client/src/index.js";
import {
  JOB_SCHEMA_VERSION,
  type JobSpec,
  type JobStateKind,
  type ObjectRef,
  type PreparationReceipt,
  type ProviderJobContext,
} from "../packages/oracle-kernel/src/index.js";
import { OracleStore } from "../packages/oracle-store/src/index.js";
import {
  OracleWorker,
  type WorkerFaultContext,
  type WorkerFaultInjector,
  type WorkerFaultPoint,
} from "../apps/oracle-worker/src/index.js";

const CHATGPT_URL = "https://chatgpt.com/";
const CAPTURE_TIMEOUT_MS = 30 * 60_000;
const OPERATION_TIMEOUT_MS = CAPTURE_TIMEOUT_MS + 5 * 60_000;
const runtimeRoot = path.resolve(
  process.env.ORACLE_V2_RUNTIME_ROOT?.trim() || path.join(homedir(), ".oracle", "v2"),
);
const canaryRoot = path.join(runtimeRoot, "r7-canaries");
const workerPaths = {
  rootDir: path.join(runtimeRoot, "r7-worker"),
  sessionsDir: path.join(runtimeRoot, "r7-sessions"),
  socketPath: path.join(runtimeRoot, "run", "r7-worker.sock"),
};

type CanaryKind = "text" | "bundle" | "recovery";

interface CanaryDefinition {
  kind: CanaryKind;
  canaryId: string;
  prompt: string;
  expectedAnswer: string;
  bundle?: string;
}

interface CanaryManifest {
  schemaVersion: "oracle.r7-canary-manifest.v2";
  canaryId: string;
  kind: CanaryKind;
  definitionSha256: string;
  authorization: "owner-authorized-r7-g2";
  forwardMutation: string;
  invariants: string[];
  stopConditions: string[];
  resumptionBoundary: string;
  phase: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

const DEFINITIONS: Record<CanaryKind, CanaryDefinition> = {
  text: {
    kind: "text",
    canaryId: "r7-g2-text-v3",
    prompt:
      "Reply with exactly this single token and no punctuation or formatting: ORACLE_V2_TEXT_CANARY_OK\n",
    expectedAnswer: "ORACLE_V2_TEXT_CANARY_OK",
  },
  bundle: {
    kind: "bundle",
    canaryId: "r7-g2-bundle-v1",
    prompt:
      "Read the one attached sealed Markdown bundle. Reply with exactly the response token contained in it, with no punctuation or formatting.\n",
    expectedAnswer: "ORACLE_V2_BUNDLE_CANARY_OK",
    bundle:
      "# Oracle v2 sealed bundle canary\n\nThe exact response token is:\n\nORACLE_V2_BUNDLE_CANARY_OK\n",
  },
  recovery: {
    kind: "recovery",
    canaryId: "r7-g2-committed-capture-recovery-v2",
    prompt:
      "Reply with exactly this single token and no punctuation or formatting: ORACLE_V2_RECOVERY_CANARY_OK\n",
    expectedAnswer: "ORACLE_V2_RECOVERY_CANARY_OK",
  },
};

const HISTORICAL_ATTEMPTS = [
  {
    canaryId: "r7-g2-committed-capture-recovery-v1",
    kind: "recovery" as const,
    disposition: "preserved-unscoped-interrupt-no-resend",
  },
  {
    canaryId: "r7-g2-text-v2",
    kind: "text" as const,
    disposition: "preserved-provisional-commit-no-resend",
  },
  {
    canaryId: "r7-g2-text-v1",
    kind: "text" as const,
    disposition: "preserved-committed-risk-no-resend",
  },
] as const;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "inspect";
  if (command === "inspect") {
    printInspection();
    return;
  }
  if (command === "preflight") {
    await runPreflight();
    return;
  }
  if (command === "text" || command === "bundle" || command === "recovery") {
    await runCanary(DEFINITIONS[command]);
    return;
  }
  throw new Error(`Unknown R7 canary command: ${command}`);
}

async function runPreflight(): Promise<void> {
  const certification = requireCertification();
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  try {
    if (runtime.receipt.browserRuntimeId !== certification.browserRuntimeId) {
      throw new Error("R7 preflight runtime does not match the G1 certification");
    }
    const objects = new Map<string, Uint8Array>();
    const probeAdapter = createPreflightAdapter(runtime, objects);
    let compatibility: Awaited<ReturnType<ChatGptAdapter["probe"]>>;
    try {
      compatibility = await probeAdapter.probe();
    } finally {
      await probeAdapter.close();
    }
    if (!compatibility.compatible) {
      throw new Error("R7 preflight rejected the current ChatGPT control surface");
    }
    const preparations: PreparationReceipt[] = [];
    for (const definition of [DEFINITIONS.text, DEFINITIONS.bundle]) {
      const adapter = createPreflightAdapter(runtime, objects);
      try {
        const prompt = putMemoryObject(objects, Buffer.from(definition.prompt, "utf8"), {
          mediaType: "text/plain",
          objectClass: "prompt",
        });
        const bundle = definition.bundle
          ? putMemoryObject(objects, Buffer.from(definition.bundle, "utf8"), {
              mediaType: "text/markdown",
              objectClass: "bundle",
            })
          : undefined;
        const spec = canarySpec(definition, prompt, bundle);
        const context: ProviderJobContext = {
          jobId: `preflight-${definition.canaryId}`,
          spec,
          state: { kind: "preparing", preparationAttempt: 1 },
          stateVersion: 1,
        };
        const preparation = await adapter.prepare(context);
        await adapter.verifyPrepared(context, preparation);
        preparations.push(preparation);
      } finally {
        await adapter.close();
      }
    }
    const receipt = {
      schemaVersion: "oracle.r7-no-send-preflight.v2",
      runtimeId: runtime.receipt.runtimeId,
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      restartOrdinal: runtime.receipt.restartOrdinal,
      compatibility,
      preparations,
      promptSubmitted: false,
      automaticFallback: false,
      verifiedAt: new Date().toISOString(),
    } as const;
    writePrivateJson(path.join(canaryRoot, "preflight.json"), receipt);
    print({
      command: "preflight",
      compatible: compatibility.compatible,
      preparationCount: preparations.length,
      textModelVerified: preparations[0]?.model.verified ?? false,
      textEffortVerified: preparations[0]?.effort.verified ?? false,
      bundleComposerAnchored: preparations[1]?.bundleEvidence?.kind === "composer-anchored",
      promptSubmitted: false,
      automaticFallback: false,
    });
  } finally {
    await runtime.close();
  }
}

function createPreflightAdapter(
  runtime: Awaited<ReturnType<typeof launchOracleBrowserRuntime>>,
  objects: ReadonlyMap<string, Uint8Array>,
): ChatGptAdapter {
  const adapter = new ChatGptAdapter({
    context: runtime.context,
    browserRuntimeId: runtime.receipt.browserRuntimeId,
    urlForJob: () => CHATGPT_URL,
    openPage: (url) => runtime.openPage(url),
    adapterVersion: "chatgpt-adapter-v2-r7",
    actionTimeoutMs: 30_000,
    commitTimeoutMs: 120_000,
    maxOpenPages: 1,
  });
  adapter.bindRuntime({
    readObject(ref) {
      const bytes = objects.get(ref.sha256);
      if (!bytes) throw new Error(`Missing R7 preflight object ${ref.sha256}`);
      return bytes;
    },
  });
  return adapter;
}

async function runCanary(definition: CanaryDefinition): Promise<void> {
  const receiptPath = path.join(canaryRoot, `${definition.canaryId}-receipt.json`);
  if (existsSync(receiptPath)) {
    const receipt = readJson<Record<string, unknown>>(receiptPath);
    print({
      command: definition.kind,
      canaryId: definition.canaryId,
      state: receipt.state,
      alreadyCompleted: true,
      promptSubmitted: true,
      automaticFallback: false,
    });
    return;
  }

  let manifest = loadOrCreateManifest(definition);
  const interruptMarker = path.join(canaryRoot, `${definition.canaryId}-capture-interrupt.json`);
  let host = await startHost(
    definition.kind === "recovery"
      ? new PersistedCaptureInterrupt(interruptMarker, definition.canaryId)
      : undefined,
  );
  try {
    const prompt = await host.client.putObject(Buffer.from(definition.prompt, "utf8"), {
      mediaType: "text/plain",
      objectClass: "prompt",
    });
    const bundle = definition.bundle
      ? await host.client.putObject(Buffer.from(definition.bundle, "utf8"), {
          mediaType: "text/markdown",
          objectClass: "bundle",
        })
      : undefined;
    const admission = await host.client.admitCanary(canarySpec(definition, prompt, bundle));
    manifest = updateManifest(manifest, {
      phase: "admitted",
      jobId: admission.job.id,
    });

    let outcome = await waitForOutcome(host.client, admission.job.id, OPERATION_TIMEOUT_MS);
    if (definition.kind === "recovery" && outcome.state.kind === "recoverable") {
      if (outcome.state.basis !== "committed-capture") {
        throw new Error(`R7 recovery canary stopped at unexpected basis ${outcome.state.basis}`);
      }
      manifest = updateManifest(manifest, { phase: "committed-capture-interrupted" });
      await host.close();
      host = await startHost();
      outcome = await waitForOutcome(host.client, admission.job.id, OPERATION_TIMEOUT_MS);
    }
    if (outcome.state.kind !== "completed") {
      updateManifest(manifest, { phase: `stopped-${outcome.state.kind}` });
      throw new Error(
        `R7 ${definition.kind} canary stopped at ${outcome.state.kind}; no resend allowed`,
      );
    }
    manifest = updateManifest(manifest, { phase: "captured" });
  } finally {
    await host.close();
  }

  const receipt = validateAndRecordCanary(definition, manifest.jobId!);
  updateManifest(manifest, { phase: "completed" });
  print({
    command: definition.kind,
    canaryId: definition.canaryId,
    state: receipt.state,
    model: receipt.model,
    effort: receipt.effort,
    bundleVerified: receipt.bundleVerified,
    dispatchAtRiskEvents: receipt.dispatchAtRiskEvents,
    submissionCommittedEvents: receipt.submissionCommittedEvents,
    captureFailedEvents: receipt.captureFailedEvents,
    captureCompletedEvents: receipt.captureCompletedEvents,
    answerVerified: receipt.answerVerified,
    promptSubmitted: true,
    automaticFallback: false,
  });
}

function validateAndRecordCanary(definition: CanaryDefinition, jobId: string) {
  const store = new OracleStore(workerPaths);
  try {
    const job = store.getJob(jobId);
    if (job.state.kind !== "completed") {
      throw new Error(`Cannot certify R7 ${definition.kind} canary from ${job.state.kind}`);
    }
    const answer = store.readObject(job.state.answer).toString("utf8").trim();
    if (answer !== definition.expectedAnswer) {
      throw new Error(
        `R7 ${definition.kind} canary captured an unexpected answer; refusing certification`,
      );
    }
    if (!job.state.preparation.model.verified || !job.state.preparation.effort.verified) {
      throw new Error("R7 canary lacks independent model or Pro preparation evidence");
    }
    if (job.state.submission.committedUserTurnOrdinal === undefined) {
      throw new Error("R7 canary lacks a committed user-turn ordinal");
    }
    const bundleVerified = definition.bundle
      ? job.state.submission.bundleReceipt.required &&
        job.state.submission.bundleReceipt.verified &&
        job.state.preparation.bundleEvidence?.kind === "composer-anchored"
      : !job.state.submission.bundleReceipt.required;
    if (!bundleVerified) throw new Error("R7 canary bundle evidence is incomplete");

    const eventTypes = store
      .listEvents(jobId)
      .map((item) =>
        item.event && typeof item.event === "object" && "type" in item.event
          ? String(item.event.type)
          : "unknown",
      );
    const count = (type: string) => eventTypes.filter((candidate) => candidate === type).length;
    const dispatchAtRiskEvents = count("dispatch-marked-at-risk");
    const submissionCommittedEvents = count("submission-committed");
    const captureFailedEvents = count("capture-failed");
    const captureCompletedEvents = count("capture-completed");
    if (dispatchAtRiskEvents !== 1 || submissionCommittedEvents !== 1) {
      throw new Error("R7 canary did not preserve one durable dispatch attempt and one commit");
    }
    if (captureCompletedEvents !== 1) {
      throw new Error("R7 canary did not produce exactly one completed capture");
    }
    if (definition.kind === "recovery" && captureFailedEvents !== 1) {
      throw new Error("R7 recovery canary did not preserve exactly one capture interruption");
    }
    if (definition.kind !== "recovery" && captureFailedEvents !== 0) {
      throw new Error(`R7 ${definition.kind} canary unexpectedly entered capture recovery`);
    }
    const captureInterruptionVerified =
      definition.kind === "recovery" ? validateCaptureInterrupt(definition, jobId) : undefined;

    const receipt = {
      schemaVersion: "oracle.r7-live-canary-receipt.v2",
      canaryId: definition.canaryId,
      kind: definition.kind,
      jobId,
      state: job.state.kind,
      browserRuntimeId: job.state.preparation.browserRuntimeId,
      model: job.state.preparation.model,
      effort: job.state.preparation.effort,
      baselineConversationDigest: job.state.preparation.baselineConversationDigest,
      baselineTurnCount: job.state.preparation.baselineTurnCount,
      bundleVerified,
      submission: job.state.submission,
      capture: job.state.capture,
      answer: job.state.answer,
      answerVerified: true,
      dispatchAtRiskEvents,
      submissionCommittedEvents,
      captureFailedEvents,
      captureCompletedEvents,
      ...(captureInterruptionVerified ? { captureInterruptionVerified } : {}),
      promptSubmitted: true,
      automaticFallback: false,
      certifiedAt: new Date().toISOString(),
    } as const;
    writePrivateJson(path.join(canaryRoot, `${definition.canaryId}-receipt.json`), receipt);
    return receipt;
  } finally {
    store.close();
  }
}

async function startHost(faultInjector?: WorkerFaultInjector) {
  const certification = requireCertification();
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  if (runtime.receipt.browserRuntimeId !== certification.browserRuntimeId) {
    await runtime.close();
    throw new Error("R7 canary runtime does not match the G1 certification");
  }
  const adapter = new ChatGptAdapter({
    context: runtime.context,
    browserRuntimeId: runtime.receipt.browserRuntimeId,
    urlForJob: () => CHATGPT_URL,
    openPage: (url) => runtime.openPage(url),
    adapterVersion: "chatgpt-adapter-v2-r7",
    actionTimeoutMs: 30_000,
    commitTimeoutMs: 120_000,
  });
  const worker = new OracleWorker({
    ...workerPaths,
    provider: adapter,
    ...(faultInjector ? { faultInjector } : {}),
  });
  try {
    await worker.start();
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  const client = new OracleClient({ socketPath: workerPaths.socketPath });
  let closed = false;
  return {
    client,
    runtime,
    worker,
    async close() {
      if (closed) return;
      closed = true;
      client.close();
      try {
        await worker.stop();
      } finally {
        await runtime.close();
      }
    },
  };
}

async function waitForOutcome(client: OracleClient, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const stopping = new Set<JobStateKind>([
    "completed",
    "recoverable",
    "ambiguous",
    "failed-unsent",
    "canceled-unsent",
    "abandoned",
  ]);
  while (true) {
    const job = await client.getJob(jobId);
    if (stopping.has(job.state.kind)) return job;
    if (Date.now() >= deadline) {
      throw new Error(`R7 canary timed out at ${job.state.kind}; no resend allowed`);
    }
    await delay(1_000);
  }
}

function canarySpec(
  definition: CanaryDefinition,
  prompt: Omit<ObjectRef, "objectClass"> & { objectClass: "prompt" },
  bundle?: Omit<ObjectRef, "objectClass"> & { objectClass: "bundle" },
): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: definition.canaryId,
    idempotency: { scope: "r7-g2-live-canary", key: definition.canaryId },
    owner: { kind: "canary", canaryId: definition.canaryId },
    input: {
      prompt,
      promptSha256: prompt.sha256,
      ...(bundle ? { bundle, bundleSha256: bundle.sha256 } : {}),
    },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    policy: {
      maxCaptureMs: CAPTURE_TIMEOUT_MS,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: bundle !== undefined,
    },
  };
}

function loadOrCreateManifest(definition: CanaryDefinition): CanaryManifest {
  const manifestPath = path.join(canaryRoot, `${definition.canaryId}-manifest.json`);
  const definitionSha256 = sha256(
    Buffer.from(
      JSON.stringify({
        canaryId: definition.canaryId,
        kind: definition.kind,
        prompt: definition.prompt,
        expectedAnswer: definition.expectedAnswer,
        bundle: definition.bundle ?? null,
      }),
      "utf8",
    ),
  );
  if (existsSync(manifestPath)) {
    const manifest = readJson<CanaryManifest>(manifestPath);
    if (
      manifest.schemaVersion !== "oracle.r7-canary-manifest.v2" ||
      manifest.canaryId !== definition.canaryId ||
      manifest.definitionSha256 !== definitionSha256
    ) {
      throw new Error(`R7 canary manifest identity mismatch for ${definition.canaryId}`);
    }
    return manifest;
  }
  const now = new Date().toISOString();
  const manifest: CanaryManifest = {
    schemaVersion: "oracle.r7-canary-manifest.v2",
    canaryId: definition.canaryId,
    kind: definition.kind,
    definitionSha256,
    authorization: "owner-authorized-r7-g2",
    forwardMutation: "one synthetic ChatGPT user turn for this canary",
    invariants: [
      "GPT-5.6 Sol and Pro are independently verified before dispatch",
      "one dispatch-at-risk event and no automatic resend",
      "no private file, conversation, sidebar, account data, or fallback transport is used",
      "a committed turn remains bound to its exact conversation and successor",
    ],
    stopConditions: [
      "auth, model, Pro, attachment, or compatibility verification fails",
      "final pre-Send baseline or composer content drifts",
      "post-click commit is absent or indeterminate",
      "conversation, user-turn, attachment, or assistant-successor identity mismatches",
    ],
    resumptionBoundary:
      "after dispatch-at-risk, reattach or capture the durable job only; never create another Send attempt",
    phase: "planned",
    createdAt: now,
    updatedAt: now,
  };
  writePrivateJson(manifestPath, manifest);
  return manifest;
}

function updateManifest(
  manifest: CanaryManifest,
  patch: Pick<CanaryManifest, "phase"> & Partial<Pick<CanaryManifest, "jobId">>,
): CanaryManifest {
  const updated: CanaryManifest = {
    ...manifest,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writePrivateJson(path.join(canaryRoot, `${manifest.canaryId}-manifest.json`), updated);
  return updated;
}

class PersistedCaptureInterrupt implements WorkerFaultInjector {
  constructor(
    private readonly markerPath: string,
    private readonly targetRequestId: string,
  ) {}

  hit(point: WorkerFaultPoint, context?: Readonly<WorkerFaultContext>): void {
    if (
      point !== "during-capture" ||
      context?.requestId !== this.targetRequestId ||
      existsSync(this.markerPath)
    ) {
      return;
    }
    writePrivateJson(this.markerPath, {
      schemaVersion: "oracle.r7-capture-interrupt.v2",
      point,
      jobId: context.jobId,
      requestId: context.requestId,
      recordedAt: new Date().toISOString(),
    });
    throw new Error("R7 committed-capture recovery canary interruption");
  }
}

function validateCaptureInterrupt(definition: CanaryDefinition, jobId: string): true {
  const marker = readJson<Record<string, unknown>>(
    path.join(canaryRoot, `${definition.canaryId}-capture-interrupt.json`),
  );
  if (
    marker.schemaVersion !== "oracle.r7-capture-interrupt.v2" ||
    marker.point !== "during-capture" ||
    marker.jobId !== jobId ||
    marker.requestId !== definition.canaryId
  ) {
    throw new Error("R7 recovery canary capture interruption identity mismatch");
  }
  return true;
}

function requireCertification() {
  const certification = readRuntimeCertification(runtimeRoot);
  if (!certification) throw new Error("G1 browser runtime certification is required for R7");
  return certification;
}

function putMemoryObject<T extends "prompt" | "bundle">(
  objects: Map<string, Uint8Array>,
  bytes: Uint8Array,
  metadata: { mediaType: string; objectClass: T },
): Omit<ObjectRef, "objectClass"> & { objectClass: T } {
  const ref = {
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: metadata.mediaType,
    objectClass: metadata.objectClass,
  };
  objects.set(ref.sha256, bytes);
  return ref;
}

function printInspection(): void {
  const active = (Object.values(DEFINITIONS) as CanaryDefinition[]).map((definition) => ({
    canaryId: definition.canaryId,
    kind: definition.kind,
    disposition: "active",
    manifest: existsSync(path.join(canaryRoot, `${definition.canaryId}-manifest.json`)),
    receipt: existsSync(path.join(canaryRoot, `${definition.canaryId}-receipt.json`)),
  }));
  const historical = HISTORICAL_ATTEMPTS.map((attempt) => ({
    ...attempt,
    manifest: existsSync(path.join(canaryRoot, `${attempt.canaryId}-manifest.json`)),
    receipt: existsSync(path.join(canaryRoot, `${attempt.canaryId}-receipt.json`)),
  }));
  print({
    schemaVersion: "oracle.r7-canary-inspection.v2",
    preflight: existsSync(path.join(canaryRoot, "preflight.json")),
    canaries: [...active, ...historical],
    automaticFallback: false,
  });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
