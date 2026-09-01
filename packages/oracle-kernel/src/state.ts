import {
  parseJobEvent,
  parseJobSpec,
  parseJobState,
  type CaptureReceipt,
  type DispatchIntent,
  type FailureReceipt,
  type JobEvent,
  type JobEventType,
  type JobSpec,
  type JobState,
  type JobStateKind,
  type PreparationReceipt,
  type SubmissionReceipt,
} from "./schema.js";

export interface JobAuthority {
  jobId: string;
  spec: JobSpec;
}

export const transitionTable = {
  queued: ["preparation-started", "job-canceled-unsent"],
  preparing: ["preparation-deferred", "preparation-completed", "preparation-failed"],
  "ready-to-dispatch": ["dispatch-reserved", "preparation-failed"],
  "dispatch-reserved": ["dispatch-marked-at-risk", "preparation-failed"],
  "dispatch-at-risk": ["submission-committed", "dispatch-ambiguous", "dispatch-verified-unsent"],
  committed: ["capture-started", "capture-failed", "job-abandoned"],
  capturing: ["capture-completed", "capture-failed", "job-abandoned"],
  recoverable: ["capture-started", "verified-unsent-closed", "job-abandoned"],
  ambiguous: ["job-abandoned"],
  completed: [],
  "failed-unsent": [],
  "canceled-unsent": [],
  abandoned: [],
} as const satisfies Record<JobStateKind, readonly JobEventType[]>;

export function initialJobState(blockedBy?: "capacity" | "auth" | "provider" | "owner"): JobState {
  return blockedBy ? { kind: "queued", blockedBy } : { kind: "queued" };
}

export function reduceJob(
  authorityInput: JobAuthority,
  stateInput: JobState,
  eventInput: JobEvent,
): JobState {
  const authority = {
    jobId: requireNonEmpty(authorityInput.jobId, "jobId"),
    spec: parseJobSpec(authorityInput.spec),
  };
  const state = validateJobState(authority, parseJobState(stateInput));
  const event = parseJobEvent(eventInput);
  const allowed = transitionTable[state.kind] as readonly JobEventType[];
  if (!allowed.includes(event.type)) {
    throw new Error(`Illegal job transition: ${state.kind} + ${event.type}`);
  }

  const next = applyEvent(authority, state, event);
  return validateJobState(authority, parseJobState(next));
}

export function validateJobState(authority: JobAuthority, state: JobState): JobState {
  const { jobId, spec } = authority;
  switch (state.kind) {
    case "ready-to-dispatch":
      validatePreparation(spec, state.preparation);
      break;
    case "dispatch-reserved":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, false);
      break;
    case "dispatch-at-risk":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, true);
      break;
    case "committed":
    case "capturing":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, true);
      validateSubmission(jobId, spec, state.preparation, state.intent, state.submission);
      break;
    case "recoverable":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, true);
      if (state.basis === "committed-capture") {
        if (!state.submission) {
          throw new Error("committed-capture recovery requires a submission receipt");
        }
        validateSubmission(jobId, spec, state.preparation, state.intent, state.submission);
        validateFailure(state.failure, "committed", "capture-only");
      } else {
        if (state.submission) {
          throw new Error("verified-unsent recovery cannot contain a submission receipt");
        }
        validateFailure(state.failure, "none", "safe-new-attempt");
      }
      break;
    case "ambiguous":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, true);
      validateFailure(state.failure, "possible", "owner-required");
      break;
    case "completed":
      validatePreparation(spec, state.preparation);
      validateIntent(jobId, spec, state.preparation, state.intent, true);
      validateSubmission(jobId, spec, state.preparation, state.intent, state.submission);
      validateCapture(state.submission, state.capture, state.answer.sha256);
      break;
    case "failed-unsent":
      validateFailure(state.failure, "none", "safe-new-attempt");
      break;
    case "abandoned":
      if (state.submission) validateStandaloneSubmission(jobId, spec, state.submission);
      break;
    case "queued":
    case "preparing":
    case "canceled-unsent":
      break;
  }
  return state;
}

function applyEvent(authority: JobAuthority, state: JobState, event: JobEvent): JobState {
  switch (event.type) {
    case "preparation-started":
      return { kind: "preparing", preparationAttempt: event.attempt };
    case "preparation-deferred":
      return { kind: "queued" };
    case "preparation-completed":
      validatePreparation(authority.spec, event.receipt);
      return { kind: "ready-to-dispatch", preparation: event.receipt };
    case "preparation-failed":
      validateFailure(event.failure, "none", "safe-new-attempt");
      return { kind: "failed-unsent", retrySafe: true, failure: event.failure };
    case "dispatch-reserved": {
      const preparation = requirePreparationState(state);
      validateIntent(authority.jobId, authority.spec, preparation, event.intent, false);
      return { kind: "dispatch-reserved", preparation, intent: event.intent };
    }
    case "dispatch-marked-at-risk": {
      const reserved = requireState(state, "dispatch-reserved");
      return {
        kind: "dispatch-at-risk",
        preparation: reserved.preparation,
        intent: { ...reserved.intent, atRiskAt: event.atRiskAt },
      };
    }
    case "submission-committed": {
      const atRisk = requireState(state, "dispatch-at-risk");
      validateSubmission(
        authority.jobId,
        authority.spec,
        atRisk.preparation,
        atRisk.intent,
        event.receipt,
      );
      return {
        kind: "committed",
        preparation: atRisk.preparation,
        intent: atRisk.intent,
        submission: event.receipt,
      };
    }
    case "dispatch-ambiguous": {
      const atRisk = requireState(state, "dispatch-at-risk");
      validateFailure(event.failure, "possible", "owner-required");
      return {
        kind: "ambiguous",
        preparation: atRisk.preparation,
        intent: atRisk.intent,
        failure: event.failure,
      };
    }
    case "dispatch-verified-unsent": {
      const atRisk = requireState(state, "dispatch-at-risk");
      validateFailure(event.failure, "none", "safe-new-attempt");
      return {
        kind: "recoverable",
        basis: "verified-unsent",
        preparation: atRisk.preparation,
        intent: atRisk.intent,
        failure: event.failure,
      };
    }
    case "capture-started": {
      const committed = requireCommittedState(state);
      return { ...committed, kind: "capturing", captureAttempt: event.attempt };
    }
    case "capture-completed": {
      const capturing = requireState(state, "capturing");
      validateCapture(capturing.submission, event.receipt, event.answer.sha256);
      return {
        kind: "completed",
        preparation: capturing.preparation,
        intent: capturing.intent,
        submission: capturing.submission,
        capture: event.receipt,
        answer: event.answer,
      };
    }
    case "capture-failed": {
      const committed = requireCommittedState(state);
      validateFailure(event.failure, "committed", "capture-only");
      return {
        kind: "recoverable",
        basis: "committed-capture",
        preparation: committed.preparation,
        intent: committed.intent,
        submission: committed.submission,
        failure: event.failure,
      };
    }
    case "verified-unsent-closed":
      requireRecoverableBasis(state, "verified-unsent");
      validateFailure(event.failure, "none", "safe-new-attempt");
      return { kind: "failed-unsent", retrySafe: true, failure: event.failure };
    case "job-canceled-unsent":
      return { kind: "canceled-unsent", ownerReason: event.reason };
    case "job-abandoned":
      return {
        kind: "abandoned",
        ...(hasSubmission(state) ? { submission: state.submission } : {}),
        ownerReason: event.reason,
      };
  }
}

function validatePreparation(spec: JobSpec, receipt: PreparationReceipt): void {
  assertEqual(receipt.promptSha256, spec.input.promptSha256, "preparation promptSha256");
  assertEqual(receipt.bundleSha256, spec.input.bundleSha256, "preparation bundleSha256");
  if (spec.input.bundleSha256) {
    if (receipt.bundleEvidence?.kind !== "composer-anchored") {
      throw new Error("bundle preparation requires composer-anchored evidence");
    }
    assertEqual(
      receipt.bundleEvidence.artifactSha256,
      spec.input.bundleSha256,
      "preparation bundle artifact",
    );
  } else if (receipt.bundleEvidence) {
    throw new Error("text-only preparation cannot contain bundleEvidence");
  }
}

function validateIntent(
  jobId: string,
  spec: JobSpec,
  preparation: PreparationReceipt,
  intent: DispatchIntent,
  requireAtRisk: boolean,
): void {
  assertEqual(intent.jobId, jobId, "dispatch jobId");
  assertEqual(intent.promptSha256, spec.input.promptSha256, "dispatch promptSha256");
  assertEqual(intent.bundleSha256, spec.input.bundleSha256, "dispatch bundleSha256");
  assertEqual(
    intent.baselineConversationDigest,
    preparation.baselineConversationDigest,
    "dispatch baselineConversationDigest",
  );
  assertEqual(
    intent.baselineTurnCount,
    preparation.baselineTurnCount,
    "dispatch baselineTurnCount",
  );
  const expectedFooter = `[Oracle receipt: job=${jobId}; turn=${intent.turnAttemptId}; prompt=${spec.input.promptSha256.slice(0, 12)}; bundle=${spec.input.bundleSha256?.slice(0, 12) ?? "none"}]`;
  assertEqual(intent.receiptFooter, expectedFooter, "dispatch receiptFooter");
  if (requireAtRisk !== (intent.atRiskAt !== undefined)) {
    throw new Error(
      requireAtRisk
        ? "dispatch-at-risk state requires atRiskAt"
        : "dispatch-reserved state cannot contain atRiskAt",
    );
  }
}

function validateSubmission(
  jobId: string,
  spec: JobSpec,
  preparation: PreparationReceipt,
  intent: DispatchIntent,
  receipt: SubmissionReceipt,
): void {
  validateStandaloneSubmission(jobId, spec, receipt);
  assertEqual(receipt.turnAttemptId, intent.turnAttemptId, "submission turnAttemptId");
  assertEqual(receipt.promptSha256, intent.promptSha256, "submission promptSha256");
  assertEqual(receipt.bundleSha256, intent.bundleSha256, "submission bundleSha256");
  assertEqual(
    receipt.modelReceipt.adapterVersion,
    preparation.adapterVersion,
    "submission adapterVersion",
  );
  assertEqual(
    receipt.modelReceipt.uiFingerprint,
    preparation.uiFingerprint,
    "submission uiFingerprint",
  );
}

function validateStandaloneSubmission(
  jobId: string,
  spec: JobSpec,
  receipt: SubmissionReceipt,
): void {
  assertEqual(receipt.jobId, jobId, "submission jobId");
  assertEqual(receipt.promptSha256, spec.input.promptSha256, "submission promptSha256");
  assertEqual(receipt.bundleSha256, spec.input.bundleSha256, "submission bundleSha256");
  if (spec.conversation) {
    assertEqual(
      receipt.conversationId,
      spec.conversation.conversationId,
      "follow-up conversationId",
    );
    assertEqual(
      receipt.conversationUrl,
      spec.conversation.conversationUrl,
      "follow-up conversationUrl",
    );
  }
  if (spec.input.bundleSha256) {
    if (!receipt.bundleReceipt.required) {
      throw new Error("bundle job requires a verified required bundleReceipt");
    }
    assertEqual(
      receipt.bundleReceipt.artifactSha256,
      spec.input.bundleSha256,
      "submission bundleReceipt artifact",
    );
  } else if (receipt.bundleReceipt.required) {
    throw new Error("text-only job cannot contain a required bundleReceipt");
  }
}

function validateCapture(
  submission: SubmissionReceipt,
  receipt: CaptureReceipt,
  answerSha256: string,
): void {
  assertEqual(receipt.conversationId, submission.conversationId, "capture conversationId");
  assertEqual(receipt.responseSha256, answerSha256, "capture answer sha256");
}

function validateFailure(
  failure: FailureReceipt,
  risk: FailureReceipt["externalEffectRisk"],
  retryPolicy: FailureReceipt["retryPolicy"],
): void {
  assertEqual(failure.externalEffectRisk, risk, "failure externalEffectRisk");
  assertEqual(failure.retryPolicy, retryPolicy, "failure retryPolicy");
}

function requirePreparationState(
  state: JobState,
): Extract<JobState, { kind: "ready-to-dispatch" }>["preparation"] {
  return requireState(state, "ready-to-dispatch").preparation;
}

function requireCommittedState(
  state: JobState,
): Extract<JobState, { kind: "committed" | "capturing" }> {
  if (state.kind === "committed" || state.kind === "capturing") return state;
  if (state.kind === "recoverable" && state.basis === "committed-capture" && state.submission) {
    return {
      kind: "committed",
      preparation: state.preparation,
      intent: state.intent,
      submission: state.submission,
    };
  }
  throw new Error(`Expected committed authority, received ${state.kind}`);
}

function requireRecoverableBasis(
  state: JobState,
  basis: "committed-capture" | "verified-unsent",
): void {
  if (state.kind !== "recoverable" || state.basis !== basis) {
    throw new Error(`Expected recoverable(${basis}), received ${state.kind}`);
  }
}

function requireState<K extends JobStateKind>(
  state: JobState,
  kind: K,
): Extract<JobState, { kind: K }> {
  if (state.kind !== kind) throw new Error(`Expected ${kind}, received ${state.kind}`);
  return state as Extract<JobState, { kind: K }>;
}

function hasSubmission(
  state: JobState,
): state is Extract<JobState, { submission: SubmissionReceipt }> {
  return "submission" in state && state.submission !== undefined;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}`);
  }
}
