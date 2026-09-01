import { describe, expect, test } from "vitest";
import {
  JOB_EVENT_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  getJobActionPolicy,
  initialJobState,
  parseJobEvent,
  parseJobSpec,
  reduceJob as reduceJobAggregate,
  transitionTable,
  type CaptureReceipt,
  type DispatchIntent,
  type FailureReceipt,
  type JobEvent,
  type JobSpec,
  type JobState,
  type PreparationReceipt,
  type SubmissionReceipt,
} from "../../packages/oracle-kernel/src/index.js";

const NOW = "2026-08-31T08:00:00.000Z";
const PROMPT_SHA = "a".repeat(64);
const BUNDLE_SHA = "b".repeat(64);
const ANSWER_SHA = "c".repeat(64);
const JOB_ID = "job_01";
const TURN_ID = "turn_01";

function objectRef<T extends "prompt" | "bundle" | "answer">(
  sha256: string,
  objectClass: T,
): { sha256: string; sizeBytes: number; mediaType: string; objectClass: T } {
  return {
    sha256,
    sizeBytes: 12,
    mediaType: objectClass === "bundle" ? "text/markdown" : "text/plain",
    objectClass,
  };
}

function jobSpec(options: { bundle?: boolean; followup?: boolean } = {}): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: "request_01",
    idempotency: { scope: "cli:local", key: "invocation_01" },
    owner: { kind: "ordinary", sessionSlug: "kernel-review" },
    input: {
      prompt: objectRef(PROMPT_SHA, "prompt"),
      ...(options.bundle ? { bundle: objectRef(BUNDLE_SHA, "bundle") } : {}),
      promptSha256: PROMPT_SHA,
      ...(options.bundle ? { bundleSha256: BUNDLE_SHA } : {}),
    },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    ...(options.followup
      ? {
          conversation: {
            parentJobId: "job_parent",
            conversationId: "conversation_01",
            conversationUrl: "https://chatgpt.com/c/conversation_01",
          },
        }
      : {}),
    policy: {
      maxCaptureMs: 3_600_000,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: options.bundle ?? false,
    },
  };
}

function preparation(options: { bundle?: boolean } = {}): PreparationReceipt {
  return {
    adapterVersion: "adapter-v2",
    uiFingerprint: "ui-fixture-1",
    browserRuntimeId: "runtime-fixture-1",
    promptSha256: PROMPT_SHA,
    ...(options.bundle ? { bundleSha256: BUNDLE_SHA } : {}),
    baselineConversationDigest: "baseline-digest",
    baselineTurnCount: 0,
    model: { requested: "gpt-5.6-sol", observedLabel: "GPT-5.6 Sol", verified: true },
    effort: { requested: "pro", observedLabel: "Pro", controlKind: "slider", verified: true },
    ...(options.bundle
      ? {
          bundleEvidence: {
            kind: "composer-anchored" as const,
            source: "chip" as const,
            artifactSha256: BUNDLE_SHA,
          },
        }
      : {}),
    preparedAt: NOW,
  };
}

function intent(options: { bundle?: boolean; atRisk?: boolean } = {}): DispatchIntent {
  return {
    jobId: JOB_ID,
    turnAttemptId: TURN_ID,
    promptSha256: PROMPT_SHA,
    ...(options.bundle ? { bundleSha256: BUNDLE_SHA } : {}),
    baselineConversationDigest: "baseline-digest",
    baselineTurnCount: 0,
    receiptFooter: `[Oracle receipt: job=${JOB_ID}; turn=${TURN_ID}; prompt=${PROMPT_SHA.slice(0, 12)}; bundle=${options.bundle ? BUNDLE_SHA.slice(0, 12) : "none"}]`,
    reservedAt: NOW,
    ...(options.atRisk ? { atRiskAt: NOW } : {}),
  };
}

function submission(
  options: { bundle?: boolean; conversationId?: string } = {},
): SubmissionReceipt {
  const conversationId = options.conversationId ?? "conversation_01";
  return {
    jobId: JOB_ID,
    turnAttemptId: TURN_ID,
    promptSha256: PROMPT_SHA,
    ...(options.bundle ? { bundleSha256: BUNDLE_SHA } : {}),
    committedAt: NOW,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    committedUserTurnOrdinal: 1,
    userTurnDigest: "user-turn-digest",
    receiptFooterVerified: true,
    modelReceipt: {
      model: "gpt-5.6-sol",
      effort: "pro",
      adapterVersion: "adapter-v2",
      uiFingerprint: "ui-fixture-1",
    },
    bundleReceipt: options.bundle
      ? {
          required: true,
          committedTurnEvidence: "attachment-ui",
          artifactSha256: BUNDLE_SHA,
          verified: true,
        }
      : { required: false },
  };
}

function capture(conversationId = "conversation_01"): CaptureReceipt {
  return {
    conversationId,
    assistantTurnDigest: "assistant-turn-digest",
    responseSha256: ANSWER_SHA,
    capturedAt: NOW,
    completionEvidence: ["stream-stopped", "assistant-turn-stable"],
    markdownQuality: "native-copy",
    adapterVersion: "adapter-v2",
    warnings: [],
  };
}

function failure(overrides: Partial<FailureReceipt> = {}): FailureReceipt {
  return {
    code: "fixture_failure",
    phase: "fixture",
    message: "Injected fixture failure",
    occurredAt: NOW,
    externalEffectRisk: "none",
    retryPolicy: "safe-new-attempt",
    ...overrides,
  };
}

function event<T extends Omit<JobEvent, "schemaVersion">>(value: T): JobEvent {
  return { schemaVersion: JOB_EVENT_SCHEMA_VERSION, ...value } as JobEvent;
}

function reduceJob(spec: JobSpec, state: JobState, nextEvent: JobEvent): JobState {
  return reduceJobAggregate({ jobId: JOB_ID, spec }, state, nextEvent);
}

describe("Oracle v2 JobSpec schema", () => {
  test("accepts the strict canonical route and binds declared object digests", () => {
    expect(parseJobSpec(jobSpec({ bundle: true }))).toEqual(jobSpec({ bundle: true }));
  });

  test("rejects unknown fields, route drift, and prompt or bundle identity mismatch", () => {
    expect(() => parseJobSpec({ ...jobSpec(), transport: "legacy-cdp" })).toThrow(
      /Unrecognized key/u,
    );
    expect(() =>
      parseJobSpec({
        ...jobSpec(),
        route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "high" },
      }),
    ).toThrow(/pro/u);
    expect(() =>
      parseJobSpec({
        ...jobSpec(),
        input: { ...jobSpec().input, promptSha256: "d".repeat(64) },
      }),
    ).toThrow(/promptSha256/u);
    expect(() =>
      parseJobSpec({
        ...jobSpec({ bundle: true }),
        input: { ...jobSpec({ bundle: true }).input, bundleSha256: "d".repeat(64) },
      }),
    ).toThrow(/bundleSha256/u);
  });

  test("requires explicit no-resend policy and committed bundle evidence when a bundle exists", () => {
    expect(() =>
      parseJobSpec({
        ...jobSpec(),
        policy: { ...jobSpec().policy, allowAutomaticResend: true },
      }),
    ).toThrow(/false/u);
    expect(() =>
      parseJobSpec({
        ...jobSpec({ bundle: true }),
        policy: { ...jobSpec({ bundle: true }).policy, requireCommittedBundleEvidence: false },
      }),
    ).toThrow(/requireCommittedBundleEvidence/u);
  });

  test("fails closed on unknown versions and accepts only explicit upcasters", () => {
    const legacy = { ...jobSpec(), schemaVersion: "oracle.job.v1", legacyRequest: "old" };
    expect(() => parseJobSpec(legacy)).toThrow(/No upcaster registered/u);

    const parsed = parseJobSpec(legacy, {
      "oracle.job.v1": (input) => {
        const { legacyRequest: _legacyRequest, ...rest } = input;
        return { ...rest, schemaVersion: JOB_SCHEMA_VERSION };
      },
    });
    expect(parsed.schemaVersion).toBe(JOB_SCHEMA_VERSION);
  });
});

describe("Oracle v2 reducer", () => {
  test("completes one text job only through the declared receipt chain", () => {
    const spec = jobSpec();
    let state: JobState = initialJobState();
    state = reduceJob(spec, state, event({ type: "preparation-started", attempt: 1 }));
    state = reduceJob(
      spec,
      state,
      event({ type: "preparation-completed", receipt: preparation() }),
    );
    state = reduceJob(spec, state, event({ type: "dispatch-reserved", intent: intent() }));
    state = reduceJob(spec, state, event({ type: "dispatch-marked-at-risk", atRiskAt: NOW }));
    state = reduceJob(spec, state, event({ type: "submission-committed", receipt: submission() }));
    state = reduceJob(spec, state, event({ type: "capture-started", attempt: 1 }));
    state = reduceJob(
      spec,
      state,
      event({
        type: "capture-completed",
        receipt: capture(),
        answer: objectRef(ANSWER_SHA, "answer"),
      }),
    );

    expect(state.kind).toBe("completed");
    expect(state).toMatchObject({
      submission: { jobId: JOB_ID, turnAttemptId: TURN_ID },
      capture: { conversationId: "conversation_01", responseSha256: ANSWER_SHA },
      answer: { sha256: ANSWER_SHA },
    });
  });

  test("requires composer-anchored and committed-turn bundle evidence", () => {
    const spec = jobSpec({ bundle: true });
    const preparing = reduceJob(
      spec,
      initialJobState(),
      event({ type: "preparation-started", attempt: 1 }),
    );
    expect(() =>
      reduceJob(
        spec,
        preparing,
        event({
          type: "preparation-completed",
          receipt: {
            ...preparation({ bundle: true }),
            bundleEvidence: {
              kind: "input-only",
              artifactSha256: BUNDLE_SHA,
            },
          },
        }),
      ),
    ).toThrow(/composer-anchored/u);

    const atRisk = reachAtRisk(spec, true);
    expect(() =>
      reduceJob(
        spec,
        atRisk,
        event({
          type: "submission-committed",
          receipt: { ...submission({ bundle: true }), bundleReceipt: { required: false } },
        }),
      ),
    ).toThrow(/bundleReceipt/u);
  });

  test("rejects receipt identity drift and wrong-conversation capture", () => {
    const spec = jobSpec();
    const atRisk = reachAtRisk(spec);
    expect(() =>
      reduceJob(
        spec,
        atRisk,
        event({
          type: "submission-committed",
          receipt: { ...submission(), promptSha256: "d".repeat(64) },
        }),
      ),
    ).toThrow(/promptSha256/u);

    const committed = reduceJob(
      spec,
      atRisk,
      event({ type: "submission-committed", receipt: submission() }),
    );
    const capturing = reduceJob(spec, committed, event({ type: "capture-started", attempt: 1 }));
    expect(() =>
      reduceJob(
        spec,
        capturing,
        event({
          type: "capture-completed",
          receipt: capture("conversation_wrong"),
          answer: objectRef(ANSWER_SHA, "answer"),
        }),
      ),
    ).toThrow(/conversation/u);
    expect(() =>
      reduceJob(
        spec,
        capturing,
        event({
          type: "capture-completed",
          receipt: capture(),
          answer: objectRef("d".repeat(64), "answer"),
        }),
      ),
    ).toThrow(/answer/u);
  });

  test("never returns from dispatch-at-risk to a Send-authorized state", () => {
    const spec = jobSpec();
    const atRisk = reachAtRisk(spec);
    expect(getJobActionPolicy(atRisk)).toMatchObject({
      automaticAction: "recover-commit",
      sendAuthority: "forbidden",
    });
    expect(() =>
      reduceJob(spec, atRisk, event({ type: "dispatch-reserved", intent: intent() })),
    ).toThrow(/Illegal job transition/u);
    expect(() =>
      reduceJob(spec, atRisk, event({ type: "dispatch-marked-at-risk", atRiskAt: NOW })),
    ).toThrow(/Illegal job transition/u);

    const ambiguous = reduceJob(
      spec,
      atRisk,
      event({
        type: "dispatch-ambiguous",
        failure: failure({ externalEffectRisk: "possible", retryPolicy: "owner-required" }),
      }),
    );
    expect(getJobActionPolicy(ambiguous)).toEqual({
      automaticAction: "none",
      sendAuthority: "forbidden",
      ownerAction: "abandon-only",
    });
    expect(() =>
      reduceJob(ambiguousSpec(), ambiguous, event({ type: "preparation-started", attempt: 2 })),
    ).toThrow(/Illegal job transition/u);
  });

  test("fails closed on a forged receipt footer", () => {
    const spec = jobSpec();
    const preparing = reduceJob(
      spec,
      initialJobState(),
      event({ type: "preparation-started", attempt: 1 }),
    );
    const ready = reduceJob(
      spec,
      preparing,
      event({ type: "preparation-completed", receipt: preparation() }),
    );
    expect(() =>
      reduceJob(
        spec,
        ready,
        event({
          type: "dispatch-reserved",
          intent: { ...intent(), receiptFooter: "[Oracle receipt: forged]" },
        }),
      ),
    ).toThrow(/receiptFooter/u);
  });

  test("separates committed capture recovery from verified-unsent owner retry", () => {
    const spec = jobSpec();
    const atRisk = reachAtRisk(spec);
    const verifiedUnsent = reduceJob(
      spec,
      atRisk,
      event({
        type: "dispatch-verified-unsent",
        failure: failure({ code: "no_commit", retryPolicy: "safe-new-attempt" }),
      }),
    );
    expect(getJobActionPolicy(verifiedUnsent)).toEqual({
      automaticAction: "none",
      sendAuthority: "forbidden",
      ownerAction: "create-new-attempt",
    });
    expect(
      getJobActionPolicy(
        reduceJob(
          spec,
          verifiedUnsent,
          event({
            type: "verified-unsent-closed",
            failure: failure({ code: "no_commit", retryPolicy: "safe-new-attempt" }),
          }),
        ),
      ),
    ).toEqual({
      automaticAction: "none",
      sendAuthority: "forbidden",
      ownerAction: "create-new-attempt",
    });

    const committed = reduceJob(
      spec,
      atRisk,
      event({ type: "submission-committed", receipt: submission() }),
    );
    const recoverable = reduceJob(
      spec,
      committed,
      event({
        type: "capture-failed",
        failure: failure({ externalEffectRisk: "committed", retryPolicy: "capture-only" }),
      }),
    );
    expect(getJobActionPolicy(recoverable)).toEqual({
      automaticAction: "capture",
      sendAuthority: "forbidden",
      ownerAction: "abandon",
    });
    expect(reduceJob(spec, recoverable, event({ type: "capture-started", attempt: 2 })).kind).toBe(
      "capturing",
    );
  });

  test("does not schedule a provider-blocked queue", () => {
    expect(getJobActionPolicy(initialJobState("provider"))).toEqual({
      automaticAction: "none",
      sendAuthority: "available-before-at-risk",
      ownerAction: "none",
    });
    expect(getJobActionPolicy(initialJobState()).automaticAction).toBe("schedule");
  });

  test("publishes an exact transition table and rejects every unlisted event", () => {
    expect(transitionTable).toEqual({
      queued: ["preparation-started", "job-canceled-unsent"],
      preparing: ["preparation-deferred", "preparation-completed", "preparation-failed"],
      "ready-to-dispatch": ["dispatch-reserved", "preparation-failed"],
      "dispatch-reserved": ["dispatch-marked-at-risk", "preparation-failed"],
      "dispatch-at-risk": [
        "submission-committed",
        "dispatch-ambiguous",
        "dispatch-verified-unsent",
      ],
      committed: ["capture-started", "capture-failed", "job-abandoned"],
      capturing: ["capture-completed", "capture-failed", "job-abandoned"],
      recoverable: ["capture-started", "verified-unsent-closed", "job-abandoned"],
      ambiguous: ["job-abandoned"],
      completed: [],
      "failed-unsent": [],
      "canceled-unsent": [],
      abandoned: [],
    });

    const completed: JobState = {
      kind: "completed",
      preparation: preparation(),
      intent: intent({ atRisk: true }),
      submission: submission(),
      capture: capture(),
      answer: objectRef(ANSWER_SHA, "answer"),
    };
    expect(() =>
      reduceJob(jobSpec(), completed, event({ type: "preparation-started", attempt: 2 })),
    ).toThrow(/Illegal job transition/u);
  });

  test("strictly parses versioned events", () => {
    expect(parseJobEvent(event({ type: "preparation-started", attempt: 1 }))).toEqual(
      event({ type: "preparation-started", attempt: 1 }),
    );
    expect(() =>
      parseJobEvent({ ...event({ type: "preparation-started", attempt: 1 }), extra: true }),
    ).toThrow(/Unrecognized key/u);
    expect(() =>
      parseJobEvent({ ...event({ type: "preparation-started", attempt: 1 }), schemaVersion: "v1" }),
    ).toThrow(/oracle\.job-event\.v2/u);
  });
});

function reachAtRisk(spec: JobSpec, bundle = false): JobState {
  const preparing = reduceJob(
    spec,
    initialJobState(),
    event({ type: "preparation-started", attempt: 1 }),
  );
  const ready = reduceJob(
    spec,
    preparing,
    event({ type: "preparation-completed", receipt: preparation({ bundle }) }),
  );
  const reserved = reduceJob(
    spec,
    ready,
    event({ type: "dispatch-reserved", intent: intent({ bundle }) }),
  );
  return reduceJob(spec, reserved, event({ type: "dispatch-marked-at-risk", atRiskAt: NOW }));
}

function ambiguousSpec(): JobSpec {
  return jobSpec();
}
