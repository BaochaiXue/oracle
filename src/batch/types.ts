import type { BrowserBundleFormat } from "../oracle/types.js";

export const BATCH_SCHEMA_VERSION = "oracle.batch.v1" as const;
export const BUNDLE_SCHEMA_VERSION = "oracle.bundle.v1" as const;

export type BundleRole = "sources" | "evidence" | "screenshots" | "current-patch" | "lane-answers";

export interface BatchManifestV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  slug: string;
  project: string;
  objective: string;
  cwd?: string;
  sharedAuthority?: {
    revisionLabel?: string;
    files: string[];
  };
  policy?: {
    maxParallel?: number;
    maxChildSessions?: number;
    allowanceGate?: "pause-batch";
    partialSynthesis?: "owner-explicit";
    revealLaneAnswersBeforeBarrier?: false;
  };
  lanes: BatchLaneSpec[];
  synthesis?: BatchSynthesisSpec;
}

export interface BatchLaneSpec {
  id: string;
  title: string;
  mandate: string;
  whyThisLane: string;
  falsificationTarget: string;
  prompt: string;
  files?: string[];
  bundleRole?: Exclude<BundleRole, "lane-answers">;
  outputContract: string[];
}

export interface BatchSynthesisSpec {
  id: string;
  title: string;
  prompt: string;
  files?: string[];
  requiredOutput: string[];
}

export interface ResolvedBatchFiles {
  sharedAuthority: string[];
  lanes: Record<string, string[]>;
  synthesis: string[];
}

export interface LoadedBatchManifest {
  sourcePath: string;
  sourceText: string;
  cwd: string;
  manifest: BatchManifestV1;
  files: ResolvedBatchFiles;
}

export interface SourceFileIdentity {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface GitAuthoritySnapshot {
  head?: string;
  branch?: string;
  dirty?: boolean;
}

export interface BundleIdentity {
  label: string;
  project?: string;
  subject?: string;
  role: BundleRole;
  sourceSetSha256: string;
  instanceId: string;
  artifactSha256?: string;
  filename: string;
}

export interface BundleManifestV1 {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  label: string;
  project?: string;
  subject?: string;
  role: BundleRole;
  files: SourceFileIdentity[];
  sourceSetSha256: string;
  instanceId: string;
}

export interface BundleContext {
  batchId?: string;
  laneId?: string;
  sessionId?: string;
  authorityRevision?: string;
  artifactInstanceId?: string;
}

export interface SealedAttachment {
  path: string;
  displayPath: string;
  sizeBytes: number;
  generatedBundle?: boolean;
}

export interface SealedBrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: SealedAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  attachmentsPolicy: "always";
  attachmentMode: "upload" | "bundle";
  bundled?: {
    originalCount: number;
    bundlePath: string;
    format?: BrowserBundleFormat;
  } | null;
  fallback?: null;
}

export type BatchStatus =
  | "preparing"
  | "sealed"
  | "running"
  | "awaiting-recovery"
  | "awaiting-owner"
  | "synthesizing"
  | "completed"
  | "partial"
  | "error"
  | "interrupted";

export type BatchLaneStatus =
  | "pending"
  | "sealed"
  | "session-created"
  | "claimed"
  | "running"
  | "recoverable"
  | "indeterminate"
  | "abandoned"
  | "completed"
  | "error";

export interface BatchLaneAttempt {
  attempt: number;
  sessionId: string;
  createdAt: string;
  phase?: "created" | "claimed" | "started" | "completed" | "failed" | "abandoned";
  claimedAt?: string;
  dispatchStartedAt?: string;
  completedAt?: string;
}

export interface BatchLaneState {
  id: string;
  role: "lane" | "synthesis";
  status: BatchLaneStatus;
  required: boolean;
  inputManifestSha256?: string;
  inputManifestPath?: string;
  outputPath?: string;
  outputSha256?: string;
  sessionId?: string;
  attempts: BatchLaneAttempt[];
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  acceptedMissing?: boolean;
  dispatchReservation?: {
    pid: number;
    token?: string;
    reservedAt: string;
  };
  lastError?: {
    code?: string;
    message: string;
    retrySafe?: boolean;
  };
}

export interface BatchOwnerDecision {
  type: "allow-partial" | "accept-missing";
  decidedAt: string;
  missingLaneIds: string[];
  laneId?: string;
  stageId?: string;
  stageRole?: "lane" | "synthesis";
  reason?: string;
  sessionId?: string;
}

export interface BatchStateV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  slug: string;
  project: string;
  objective: string;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  sourceManifestSha256?: string;
  sourceSnapshotManifestSha256?: string;
  effectiveMaxParallel: number;
  effectiveMaxChildSessions: number;
  barrierClosedAt?: string;
  synthesisEligible?: boolean;
  admittedSourceDrift?: boolean;
  /** Legacy draft-state field retained only so existing local recovery specimens remain readable. */
  workspaceDrift?: boolean;
  lanes: BatchLaneState[];
  synthesis?: BatchLaneState;
  ownerDecisions?: BatchOwnerDecision[];
  lastError?: {
    code?: string;
    message: string;
  };
}

export interface BatchSourceManifestV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  capturedAt: string;
  cwd: string;
  git: GitAuthoritySnapshot;
  manifestSha256: string;
  snapshotManifestSha256?: string;
  files: SourceFileIdentity[];
  sharedAuthority?: string[];
  lanes?: Record<string, string[]>;
  synthesis?: string[];
}

export interface BatchInputManifestV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  laneId: string;
  role: "lane" | "synthesis";
  sealedAt: string;
  promptSha256: string;
  sourceSnapshotManifestSha256?: string;
  attachments: SourceFileIdentity[];
  sourceFiles: SourceFileIdentity[];
  estimatedInputTokens: number;
  inputManifestSha256: string;
}

export interface BatchFirstStageSealV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  sealedAt: string;
  sourceSnapshotManifestSha256: string;
  lanes: Array<{
    id: string;
    inputManifestSha256: string;
  }>;
}

export interface BatchAnswerReceiptV1 {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  batchId: string;
  laneId: string;
  role: "lane" | "synthesis";
  sessionId: string;
  status: "completed" | "error";
  capturedAt: string;
  inputManifestSha256: string;
  answerSha256?: string;
  answerBytes?: number;
  conversationId?: string;
  error?: string;
}
