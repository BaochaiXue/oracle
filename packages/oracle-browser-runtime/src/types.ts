import type { BrowserContext, Page } from "playwright-core";

export const ORACLE_BROWSER_RUNTIME_ID = "managed-chrome-for-testing-direct-cdp" as const;

export type RuntimeAvailability = "available" | "unavailable";

export interface OracleBrowserRuntimeInspection {
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  label: "Managed Chrome for Testing over direct CDP";
  availability: RuntimeAvailability;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  executablePath?: string;
  automaticFallback: false;
  reason: string;
}

export interface RuntimeInspectionOptions {
  chromeForTestingExecutablePath?: string;
  executableExists?: (candidate: string) => boolean;
}

export interface ManagedBrowserLaunchInput {
  executablePath: string;
  profileDir: string;
  headless: boolean;
  preserveWindowNames?: readonly string[];
  singlePageLifetime?: boolean;
  captureProcessIdentity?: boolean;
  onProcessIdentity?: (identity: ManagedBrowserProcessIdentity) => Promise<void>;
}

export interface ManagedBrowserProcessIdentity {
  pid: number;
  processStartTime: string;
  executableRealpath: string;
  profileRealpath: string;
  debugHost: "127.0.0.1";
  debugPort: number;
}

export interface LaunchedManagedBrowser {
  context: BrowserContext;
  browserVersion: string;
  executablePath: string;
  restoredPageCount: number;
  preservedPages(): readonly Page[];
  processIdentity?: ManagedBrowserProcessIdentity;
  openPage(url: string): Promise<Page>;
  close(): Promise<void>;
}

export type AttemptSandboxPurpose = "dispatch" | "capture" | "probe";

export interface AuthSeedCandidateReceipt {
  schemaVersion: "oracle.auth-seed-candidate.v1";
  candidateId: string;
  sourceProfileRealpath: string;
  profileRealpath: string;
  profileDigest: string;
  createdAt: string;
}

export interface AuthSeedReceipt {
  schemaVersion: "oracle.auth-seed.v1";
  generation: string;
  profileRealpath: string;
  profileDigest: string;
  acceptedAt: string;
}

export interface CloneIsolationObservation {
  sandboxId: string;
  authenticated: boolean;
  modelVerified: boolean;
  effortVerified: boolean;
  initiallyClean: boolean;
  dirtyStateObserved: boolean;
  inheritedStateObserved: boolean;
  promptSubmitted: false;
}

export interface AuthSeedCloneProofReceipt {
  schemaVersion: "oracle.auth-seed-clone-proof.v1";
  candidateId: string;
  seedProfileDigestBefore: string;
  seedProfileDigestAfter: string;
  browserRuntimeId: string;
  executableRealpath: string;
  cloneA: CloneIsolationObservation;
  cloneACleanup: AttemptSandboxCleanupReceipt;
  cloneB: CloneIsolationObservation;
  cloneBCleanup: AttemptSandboxCleanupReceipt;
  sendEventCount: 0;
  remainingAttemptCount: 0;
  completedAt: string;
}

export interface AuthSeedCertificationReceipt {
  schemaVersion: "oracle.auth-seed-certification.v1";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  browserRuntimeId: string;
  transport: "direct-cdp";
  seedGeneration: string;
  profileRealpath: string;
  profileDigest: string;
  executableRealpath: string;
  cloneProof: AuthSeedCloneProofReceipt;
  certifiedAt: string;
}

export interface AttemptSandboxOwner {
  schemaVersion: "oracle.attempt-sandbox-owner.v1";
  jobId: string;
  turnAttemptId: string;
  purpose: AttemptSandboxPurpose;
  seedGeneration: string;
  profileRealpath: string;
  createdAt: string;
}

export interface AttemptProcessReceipt {
  schemaVersion: "oracle.attempt-process.v1";
  jobId: string;
  turnAttemptId: string;
  profileRealpath: string;
  executableRealpath: string;
  pid: number;
  processStartTime: string;
  debugHost: "127.0.0.1";
  debugPort: number;
  startedAt: string;
}

export interface AttemptSandbox {
  sandboxId: string;
  directory: string;
  profileDir: string;
  owner: AttemptSandboxOwner;
}

export interface AttemptSandboxCleanupReceipt {
  schemaVersion: "oracle.attempt-sandbox-cleanup.v1";
  sandboxId: string;
  status: "deleted" | "already-absent" | "quarantined" | "blocked";
  processStatus: "none" | "already-stopped" | "stopped" | "identity-unproven";
  completedAt: string;
  quarantinePath?: string;
  error?: string;
}

export interface OracleAttemptBrowserRuntime extends OracleBrowserRuntime {
  sandbox: AttemptSandbox;
  processReceipt: AttemptProcessReceipt;
}

export type LaunchManagedBrowser = (
  input: ManagedBrowserLaunchInput,
) => Promise<LaunchedManagedBrowser>;

export interface RuntimeLaunchReceipt {
  schemaVersion: "oracle.browser-runtime-launch.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  browserRuntimeId: string;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  profileDir: string;
  executablePath: string;
  browserVersion: string;
  restoredPageCount: number;
  restartOrdinal: number;
  automaticFallback: false;
  launchedAt: string;
  closedAt?: string;
}

export interface OracleBrowserRuntime {
  context: BrowserContext;
  receipt: RuntimeLaunchReceipt;
  openPage(url: string): Promise<Page>;
  close(): Promise<void>;
}

export const RUNTIME_ACCEPTANCE_CHECKS = [
  "login",
  "coldRestart",
  "modelAndEffortControls",
  "fileUpload",
  "playwrightClickWithoutOsFocus",
  "dailyChromeUnaffected",
  "backgroundHeadfulStability",
  "noRecurringDebugApproval",
] as const;

export type RuntimeAcceptanceCheck = (typeof RUNTIME_ACCEPTANCE_CHECKS)[number];
export type RuntimeAcceptanceResult = "pass" | "fail" | "blocked";

export interface RuntimeAcceptanceReceipt {
  schemaVersion: "oracle.browser-runtime-acceptance.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  profileDir: string;
  browserRuntimeId: string;
  restartOrdinal: number;
  checks: Record<RuntimeAcceptanceCheck, RuntimeAcceptanceResult>;
  observedBy: "owner";
  observedAt: string;
  notes?: string;
}

export interface RuntimeCertificationReceipt {
  schemaVersion: "oracle.browser-runtime-certification.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  browserRuntimeId: string;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  profileDir: string;
  executablePath: string;
  automaticFallback: false;
  acceptance: RuntimeAcceptanceReceipt;
  certifiedAt: string;
}
