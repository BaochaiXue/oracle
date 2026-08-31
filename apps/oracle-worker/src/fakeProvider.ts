import { createHash } from "node:crypto";
import { PROVIDER_CAPABILITIES } from "../../../packages/oracle-kernel/src/index.js";
import type {
  CompatibilityReceipt,
  PreparationReceipt,
  ProviderAdapter,
  ProviderCaptureContext,
  ProviderCaptureResult,
  ProviderDispatchContext,
  ProviderJobContext,
  SubmissionReceipt,
} from "../../../packages/oracle-kernel/src/index.js";

export interface FakeProviderOptions {
  preparationDelayMs?: number;
  dispatchDelayMs?: number;
  captureDelayMs?: number;
  captureFailures?: number;
  commitObservation?: "committed" | "missing";
  verificationFailures?: number;
}

export class FakeProvider implements ProviderAdapter {
  private readonly submissions = new Map<string, SubmissionReceipt>();
  private readonly sends = new Map<string, number>();
  private readonly options: FakeProviderOptions;
  private activePreparations = 0;
  private activeDispatches = 0;
  private activeCaptures = 0;
  private remainingCaptureFailures: number;
  private remainingVerificationFailures: number;
  maxConcurrentPreparations = 0;
  maxConcurrentDispatches = 0;
  maxConcurrentCaptures = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
    this.remainingCaptureFailures = options.captureFailures ?? 0;
    this.remainingVerificationFailures = options.verificationFailures ?? 0;
  }

  async probe(): Promise<CompatibilityReceipt> {
    return {
      compatible: true,
      adapterVersion: "fake-provider-v1",
      browserRuntimeId: "fake-runtime-v1",
      uiFingerprint: "fake-ui-v1",
      locale: "en-US",
      capabilities: Object.fromEntries(
        PROVIDER_CAPABILITIES.map((name) => [name, "verified" as const]),
      ) as CompatibilityReceipt["capabilities"],
      probedAt: new Date().toISOString(),
    };
  }

  async prepare(context: ProviderJobContext): Promise<PreparationReceipt> {
    this.activePreparations += 1;
    this.maxConcurrentPreparations = Math.max(
      this.maxConcurrentPreparations,
      this.activePreparations,
    );
    try {
      await delay(this.options.preparationDelayMs);
      const bundleSha256 = context.spec.input.bundleSha256;
      return {
        adapterVersion: "fake-provider-v1",
        uiFingerprint: "fake-ui-v1",
        browserRuntimeId: "fake-runtime-v1",
        promptSha256: context.spec.input.promptSha256,
        ...(bundleSha256 ? { bundleSha256 } : {}),
        model: { requested: "gpt-5.6-sol", observedLabel: "GPT-5.6 Sol", verified: true },
        effort: { requested: "pro", observedLabel: "Pro", controlKind: "slider", verified: true },
        ...(bundleSha256
          ? {
              bundleEvidence: {
                kind: "composer-anchored" as const,
                source: "chip" as const,
                artifactSha256: bundleSha256,
              },
            }
          : {}),
        preparedAt: new Date().toISOString(),
      };
    } finally {
      this.activePreparations -= 1;
    }
  }

  async verifyPrepared(): Promise<void> {
    if (this.remainingVerificationFailures > 0) {
      this.remainingVerificationFailures -= 1;
      throw new Error("Injected fake final-verification failure");
    }
  }

  async dispatchOnce(context: ProviderDispatchContext): Promise<void> {
    this.activeDispatches += 1;
    this.maxConcurrentDispatches = Math.max(this.maxConcurrentDispatches, this.activeDispatches);
    try {
      await delay(this.options.dispatchDelayMs);
      const count = (this.sends.get(context.jobId) ?? 0) + 1;
      this.sends.set(context.jobId, count);
      if (count > 1) throw new Error(`Fake provider received duplicate Send for ${context.jobId}`);
      const conversationId = context.spec.conversation?.conversationId ?? `fake-${context.jobId}`;
      const conversationUrl =
        context.spec.conversation?.conversationUrl ?? `https://chatgpt.com/c/${conversationId}`;
      const bundleSha256 = context.spec.input.bundleSha256;
      this.submissions.set(context.jobId, {
        jobId: context.jobId,
        turnAttemptId: context.intent.turnAttemptId,
        promptSha256: context.spec.input.promptSha256,
        ...(bundleSha256 ? { bundleSha256 } : {}),
        committedAt: new Date().toISOString(),
        conversationId,
        conversationUrl,
        committedUserTurnOrdinal: 1,
        userTurnDigest: `fake-user-turn-${context.jobId}`,
        receiptFooterVerified: true,
        modelReceipt: {
          model: "gpt-5.6-sol",
          effort: "pro",
          adapterVersion: "fake-provider-v1",
          uiFingerprint: "fake-ui-v1",
        },
        bundleReceipt: bundleSha256
          ? {
              required: true,
              committedTurnEvidence: "attachment-ui",
              artifactSha256: bundleSha256,
              verified: true,
            }
          : { required: false },
      });
    } finally {
      this.activeDispatches -= 1;
    }
  }

  async observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined> {
    if (this.options.commitObservation === "missing") return undefined;
    return this.submissions.get(context.jobId);
  }

  async capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult> {
    this.activeCaptures += 1;
    this.maxConcurrentCaptures = Math.max(this.maxConcurrentCaptures, this.activeCaptures);
    try {
      await delay(this.options.captureDelayMs);
      if (this.remainingCaptureFailures > 0) {
        this.remainingCaptureFailures -= 1;
        throw new Error(`Injected fake capture failure for ${context.jobId}`);
      }
      const answerBytes = Buffer.from(`Fake answer for ${context.jobId}.\n`, "utf8");
      return {
        answerBytes,
        plainTextBytes: answerBytes,
        htmlBytes: Buffer.from(`<p>Fake answer for ${context.jobId}.</p>\n`, "utf8"),
        mediaType: "text/markdown",
        receipt: {
          conversationId: context.submission.conversationId,
          assistantTurnDigest: `fake-assistant-turn-${context.jobId}`,
          responseSha256: createHash("sha256").update(answerBytes).digest("hex"),
          capturedAt: new Date().toISOString(),
          completionEvidence: ["fake-provider-terminal"],
          markdownQuality: "native-copy",
          adapterVersion: "fake-provider-v1",
          warnings: [],
        },
      };
    } finally {
      this.activeCaptures -= 1;
    }
  }

  sendCount(jobId: string): number {
    return this.sends.get(jobId) ?? 0;
  }
}

function delay(milliseconds = 0): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}
