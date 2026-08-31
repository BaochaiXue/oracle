import type {
  CaptureReceipt,
  CompatibilityReceipt,
  DispatchIntent,
  JobSpec,
  JobState,
  PreparationReceipt,
  SubmissionReceipt,
  ObjectRef,
} from "./schema.js";

export interface ProviderRuntimeBindings {
  readObject(ref: ObjectRef): Uint8Array;
}

export interface ProviderJobContext {
  jobId: string;
  spec: JobSpec;
  state: JobState;
  stateVersion: number;
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
  plainTextBytes: Uint8Array;
  htmlBytes: Uint8Array;
  mediaType: "text/markdown" | "text/plain";
}

export interface ProviderAdapter {
  bindRuntime?(bindings: ProviderRuntimeBindings): void;
  probe(): Promise<CompatibilityReceipt>;
  prepare(context: ProviderJobContext): Promise<PreparationReceipt>;
  verifyPrepared(context: ProviderJobContext, receipt: PreparationReceipt): Promise<void>;
  dispatchOnce(context: ProviderDispatchContext): Promise<void>;
  observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined>;
  capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult>;
  close?(): Promise<void>;
}
