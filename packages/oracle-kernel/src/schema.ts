import { z } from "zod";

export const JOB_SCHEMA_VERSION = "oracle.job.v2" as const;
export const JOB_EVENT_SCHEMA_VERSION = "oracle.job-event.v2" as const;

export const PROVIDER_CAPABILITIES = [
  "loginState",
  "composer",
  "modelControl",
  "modelVerification",
  "effortVerification",
  "attachmentControl",
  "sendControl",
  "userTurnLocator",
  "assistantTurnLocator",
  "conversationUrlParser",
] as const;

const nonEmpty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 digest");

export const objectRefSchema = z
  .object({
    sha256,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: nonEmpty,
    objectClass: z.enum([
      "prompt",
      "bundle",
      "answer",
      "artifact",
      "debug",
      "job-spec",
      "html",
      "text",
    ]),
  })
  .strict();

const capabilityStateSchema = z.enum(["verified", "missing", "unknown"]);

export const compatibilityReceiptSchema = z
  .object({
    compatible: z.boolean(),
    adapterVersion: nonEmpty,
    browserRuntimeId: nonEmpty,
    uiFingerprint: nonEmpty,
    locale: nonEmpty,
    capabilities: z
      .object(
        Object.fromEntries(PROVIDER_CAPABILITIES.map((name) => [name, capabilityStateSchema])),
      )
      .strict(),
    diagnosticObject: objectRefSchema.optional(),
    probedAt: timestamp,
  })
  .strict();

const promptRefSchema = objectRefSchema.extend({ objectClass: z.literal("prompt") }).strict();
const bundleRefSchema = objectRefSchema.extend({ objectClass: z.literal("bundle") }).strict();
const answerRefSchema = objectRefSchema.extend({ objectClass: z.literal("answer") }).strict();

export const jobOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ordinary"), sessionSlug: nonEmpty }).strict(),
  z
    .object({
      kind: z.literal("batch-lane"),
      batchId: nonEmpty,
      laneId: nonEmpty,
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch-synthesis"),
      batchId: nonEmpty,
      attempt: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("canary"), canaryId: nonEmpty }).strict(),
]);

export const jobSpecSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    requestId: nonEmpty,
    idempotency: z.object({ scope: nonEmpty, key: nonEmpty }).strict(),
    owner: jobOwnerSchema,
    input: z
      .object({
        prompt: promptRefSchema,
        bundle: bundleRefSchema.optional(),
        promptSha256: sha256,
        bundleSha256: sha256.optional(),
      })
      .strict(),
    route: z
      .object({
        provider: z.literal("chatgpt-web"),
        model: z.literal("gpt-5.6-sol"),
        effort: z.literal("pro"),
      })
      .strict(),
    conversation: z
      .object({
        parentJobId: nonEmpty,
        conversationId: nonEmpty,
        conversationUrl: z.url(),
      })
      .strict()
      .optional(),
    policy: z
      .object({
        maxCaptureMs: z.number().int().positive(),
        allowAutomaticCaptureRecovery: z.literal(true),
        allowAutomaticResend: z.literal(false),
        requireCommittedBundleEvidence: z.boolean(),
      })
      .strict(),
    lineage: z
      .object({
        parentJobId: nonEmpty.optional(),
        batchId: nonEmpty.optional(),
        laneId: nonEmpty.optional(),
        role: nonEmpty.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.input.prompt.sha256 !== spec.input.promptSha256) {
      context.addIssue({
        code: "custom",
        path: ["input", "promptSha256"],
        message: "promptSha256 must match input.prompt.sha256",
      });
    }
    const hasBundle = spec.input.bundle !== undefined;
    if (hasBundle !== (spec.input.bundleSha256 !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["input", "bundleSha256"],
        message: "bundle and bundleSha256 must either both exist or both be absent",
      });
    }
    if (spec.input.bundle && spec.input.bundle.sha256 !== spec.input.bundleSha256) {
      context.addIssue({
        code: "custom",
        path: ["input", "bundleSha256"],
        message: "bundleSha256 must match input.bundle.sha256",
      });
    }
    if (hasBundle !== spec.policy.requireCommittedBundleEvidence) {
      context.addIssue({
        code: "custom",
        path: ["policy", "requireCommittedBundleEvidence"],
        message: "requireCommittedBundleEvidence must be true exactly when a bundle exists",
      });
    }
  });

const composerAnchoredEvidenceSchema = z
  .object({
    kind: z.literal("composer-anchored"),
    source: z.enum(["tile", "chip", "count"]),
    artifactSha256: sha256,
  })
  .strict();

const inputOnlyEvidenceSchema = z
  .object({
    kind: z.literal("input-only"),
    artifactSha256: sha256,
  })
  .strict();

export const preparationReceiptSchema = z
  .object({
    adapterVersion: nonEmpty,
    uiFingerprint: nonEmpty,
    browserRuntimeId: nonEmpty,
    promptSha256: sha256,
    bundleSha256: sha256.optional(),
    baselineConversationDigest: nonEmpty,
    baselineTurnCount: z.number().int().nonnegative(),
    model: z
      .object({
        requested: z.literal("gpt-5.6-sol"),
        observedLabel: nonEmpty,
        verified: z.literal(true),
      })
      .strict(),
    effort: z
      .object({
        requested: z.literal("pro"),
        observedLabel: nonEmpty,
        controlKind: z.enum(["slider", "menu"]),
        verified: z.literal(true),
      })
      .strict(),
    bundleEvidence: z
      .discriminatedUnion("kind", [composerAnchoredEvidenceSchema, inputOnlyEvidenceSchema])
      .optional(),
    preparedAt: timestamp,
  })
  .strict();

export const dispatchIntentSchema = z
  .object({
    jobId: nonEmpty,
    turnAttemptId: nonEmpty,
    promptSha256: sha256,
    bundleSha256: sha256.optional(),
    baselineConversationDigest: nonEmpty,
    baselineTurnCount: z.number().int().nonnegative(),
    receiptFooter: nonEmpty,
    reservedAt: timestamp,
    atRiskAt: timestamp.optional(),
  })
  .strict();

const requiredBundleReceiptSchema = z
  .object({
    required: z.literal(true),
    committedTurnEvidence: z.enum(["attachment-ui", "message-metadata"]),
    artifactSha256: sha256,
    verified: z.literal(true),
  })
  .strict();

const noBundleReceiptSchema = z.object({ required: z.literal(false) }).strict();

export const submissionReceiptSchema = z
  .object({
    jobId: nonEmpty,
    turnAttemptId: nonEmpty,
    promptSha256: sha256,
    bundleSha256: sha256.optional(),
    committedAt: timestamp,
    conversationId: nonEmpty,
    conversationUrl: z.url(),
    committedUserTurnOrdinal: z.number().int().nonnegative().optional(),
    userTurnDigest: nonEmpty,
    receiptFooterVerified: z.literal(true),
    modelReceipt: z
      .object({
        model: z.literal("gpt-5.6-sol"),
        effort: z.literal("pro"),
        adapterVersion: nonEmpty,
        uiFingerprint: nonEmpty,
      })
      .strict(),
    bundleReceipt: z.discriminatedUnion("required", [
      requiredBundleReceiptSchema,
      noBundleReceiptSchema,
    ]),
  })
  .strict();

export const captureReceiptSchema = z
  .object({
    conversationId: nonEmpty,
    assistantTurnDigest: nonEmpty,
    responseSha256: sha256,
    capturedAt: timestamp,
    completionEvidence: z.array(nonEmpty).min(1),
    markdownQuality: z.enum(["native-copy", "html-projection", "plain-text"]),
    adapterVersion: nonEmpty,
    warnings: z.array(nonEmpty),
  })
  .strict();

export const failureReceiptSchema = z
  .object({
    code: nonEmpty,
    phase: nonEmpty,
    message: nonEmpty,
    occurredAt: timestamp,
    externalEffectRisk: z.enum(["none", "possible", "committed"]),
    retryPolicy: z.enum(["safe-new-attempt", "capture-only", "owner-required", "forbidden"]),
    diagnosticObject: objectRefSchema.optional(),
  })
  .strict();

const queuedStateSchema = z
  .object({
    kind: z.literal("queued"),
    blockedBy: z.enum(["capacity", "auth", "provider", "owner"]).optional(),
  })
  .strict();
const preparingStateSchema = z
  .object({ kind: z.literal("preparing"), preparationAttempt: z.number().int().positive() })
  .strict();
const readyStateSchema = z
  .object({ kind: z.literal("ready-to-dispatch"), preparation: preparationReceiptSchema })
  .strict();
const dispatchReservedStateSchema = z
  .object({
    kind: z.literal("dispatch-reserved"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
  })
  .strict();
const dispatchAtRiskStateSchema = z
  .object({
    kind: z.literal("dispatch-at-risk"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
  })
  .strict();
const committedStateSchema = z
  .object({
    kind: z.literal("committed"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
    submission: submissionReceiptSchema,
  })
  .strict();
const capturingStateSchema = z
  .object({
    kind: z.literal("capturing"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
    submission: submissionReceiptSchema,
    captureAttempt: z.number().int().positive(),
  })
  .strict();
const recoverableStateSchema = z
  .object({
    kind: z.literal("recoverable"),
    basis: z.enum(["committed-capture", "verified-unsent"]),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
    submission: submissionReceiptSchema.optional(),
    failure: failureReceiptSchema,
  })
  .strict();
const ambiguousStateSchema = z
  .object({
    kind: z.literal("ambiguous"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
    failure: failureReceiptSchema,
  })
  .strict();
const completedStateSchema = z
  .object({
    kind: z.literal("completed"),
    preparation: preparationReceiptSchema,
    intent: dispatchIntentSchema,
    submission: submissionReceiptSchema,
    capture: captureReceiptSchema,
    answer: answerRefSchema,
  })
  .strict();
const failedUnsentStateSchema = z
  .object({
    kind: z.literal("failed-unsent"),
    retrySafe: z.literal(true),
    failure: failureReceiptSchema,
  })
  .strict();
const canceledUnsentStateSchema = z
  .object({ kind: z.literal("canceled-unsent"), ownerReason: nonEmpty })
  .strict();
const abandonedStateSchema = z
  .object({
    kind: z.literal("abandoned"),
    submission: submissionReceiptSchema.optional(),
    ownerReason: nonEmpty,
  })
  .strict();

export const jobStateSchema = z.discriminatedUnion("kind", [
  queuedStateSchema,
  preparingStateSchema,
  readyStateSchema,
  dispatchReservedStateSchema,
  dispatchAtRiskStateSchema,
  committedStateSchema,
  capturingStateSchema,
  recoverableStateSchema,
  ambiguousStateSchema,
  completedStateSchema,
  failedUnsentStateSchema,
  canceledUnsentStateSchema,
  abandonedStateSchema,
]);

const eventBase = { schemaVersion: z.literal(JOB_EVENT_SCHEMA_VERSION) } as const;
const eventSchemas = [
  z
    .object({
      ...eventBase,
      type: z.literal("preparation-started"),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal("preparation-deferred") }).strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("preparation-completed"),
      receipt: preparationReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("preparation-failed"),
      failure: failureReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("dispatch-reserved"),
      intent: dispatchIntentSchema,
    })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("dispatch-marked-at-risk"), atRiskAt: timestamp })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("submission-committed"),
      receipt: submissionReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("dispatch-ambiguous"),
      failure: failureReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("dispatch-verified-unsent"),
      failure: failureReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("capture-started"),
      attempt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("capture-completed"),
      receipt: captureReceiptSchema,
      answer: answerRefSchema,
    })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("capture-failed"), failure: failureReceiptSchema })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("verified-unsent-closed"),
      failure: failureReceiptSchema,
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal("job-canceled-unsent"), reason: nonEmpty }).strict(),
  z.object({ ...eventBase, type: z.literal("job-abandoned"), reason: nonEmpty }).strict(),
] as const;

export const jobEventSchema = z.discriminatedUnion("type", eventSchemas);

export type ObjectRef = z.infer<typeof objectRefSchema>;
export type CompatibilityReceipt = z.infer<typeof compatibilityReceiptSchema>;
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type PreparationReceipt = z.infer<typeof preparationReceiptSchema>;
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;
export type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export type FailureReceipt = z.infer<typeof failureReceiptSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobStateKind = JobState["kind"];
export type JobEventType = JobEvent["type"];

export type JobSpecUpcaster = (input: Readonly<Record<string, unknown>>) => unknown;
export type JobSpecUpcasters = Readonly<Record<string, JobSpecUpcaster>>;

export function parseJobSpec(input: unknown, upcasters: JobSpecUpcasters = {}): JobSpec {
  let candidate = requireVersionedRecord(input, "JobSpec");
  const visited = new Set<string>();
  while (candidate.schemaVersion !== JOB_SCHEMA_VERSION) {
    const version = String(candidate.schemaVersion);
    if (visited.has(version)) throw new Error(`JobSpec upcaster cycle at ${version}`);
    visited.add(version);
    const upcaster = upcasters[version];
    if (!upcaster) {
      throw new Error(
        `Unsupported JobSpec schemaVersion ${version}. No upcaster registered for ${version}.`,
      );
    }
    candidate = requireVersionedRecord(upcaster(candidate), "upcast JobSpec");
  }
  return jobSpecSchema.parse(candidate);
}

export function parseJobEvent(input: unknown): JobEvent {
  return jobEventSchema.parse(input);
}

export function parseJobState(input: unknown): JobState {
  return jobStateSchema.parse(input);
}

function requireVersionedRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object with schemaVersion`);
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.schemaVersion !== "string" || !candidate.schemaVersion) {
    throw new Error(`${label} must include a non-empty schemaVersion`);
  }
  return candidate;
}
