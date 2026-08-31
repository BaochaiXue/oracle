import type {
  CaptureReceipt,
  DispatchIntent,
  JobSpec,
  JobState,
  PreparationReceipt,
  SubmissionReceipt,
} from "./schema.js";

export interface ProviderJobContext {
  jobId: string;
  spec: JobSpec;
  state: JobState;
}

export interface ProviderDispatchContext extends ProviderJobContext {
  intent: DispatchIntent;
}

export interface ProviderCaptureContext extends ProviderJobContext {
  submission: SubmissionReceipt;
}

export interface ProviderCaptureResult {
  receipt: CaptureReceipt;
  answerBytes: Uint8Array;
  mediaType: "text/markdown" | "text/plain";
}

export interface ProviderAdapter {
  prepare(context: ProviderJobContext): Promise<PreparationReceipt>;
  verifyPrepared(context: ProviderJobContext, receipt: PreparationReceipt): Promise<void>;
  dispatchOnce(context: ProviderDispatchContext): Promise<void>;
  observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined>;
  capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult>;
}
