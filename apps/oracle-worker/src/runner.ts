import {
  JOB_EVENT_SCHEMA_VERSION,
  type DispatchIntent,
  type FailureReceipt,
  type JobEvent,
  type ObjectRef,
  type ProviderAdapter,
  type JobSpec,
} from "../../../packages/oracle-kernel/src/index.js";
import { createHash } from "node:crypto";
import { OracleStore, type StoredJob } from "../../../packages/oracle-store/src/index.js";
import type { WorkerFaultContext, WorkerFaultInjector } from "./faults.js";
import { Mutex, Semaphore } from "./synchronization.js";

export interface JobRunnerOptions {
  store: OracleStore;
  provider: ProviderAdapter;
  faultInjector: WorkerFaultInjector;
  maxConcurrentCaptures?: number;
  allowDispatch?: boolean;
}

export class JobOperationConflictError extends Error {
  constructor(jobId: string, operation: string, state: string) {
    super(`Cannot ${operation} Oracle v2 job ${jobId} from ${state}`);
    this.name = "JobOperationConflictError";
  }
}

type JobEventInput = JobEvent extends infer Event
  ? Event extends { schemaVersion: typeof JOB_EVENT_SCHEMA_VERSION }
    ? Omit<Event, "schemaVersion">
    : never
  : never;

export class JobRunner {
  readonly store: OracleStore;
  readonly provider: ProviderAdapter;
  private readonly faultInjector: WorkerFaultInjector;
  private readonly dispatchMutex = new Mutex();
  private readonly captureSemaphore: Semaphore;
  private readonly allowDispatch: boolean;
  private readonly running = new Map<string, Promise<void>>();
  private readonly ownerRequestedReruns = new Set<string>();
  private accepting = true;
  private blocked = false;

  constructor(options: JobRunnerOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.faultInjector = options.faultInjector;
    this.allowDispatch = options.allowDispatch ?? true;
    this.captureSemaphore = new Semaphore(options.maxConcurrentCaptures ?? 3);
  }

  recover(): void {
    for (let job of this.store.listJobs()) {
      if (this.allowDispatch && job.state.kind === "queued" && job.state.blockedBy === "provider") {
        job = this.append(job, { type: "provider-unblocked" });
      }
      if (job.state.kind === "preparing") {
        job = this.append(job, { type: "preparation-deferred" });
      }
      if ((this.allowDispatch && needsDispatchLane(job)) || needsCaptureLane(job)) {
        this.schedule(job.id);
      }
    }
  }

  schedule(jobId: string): void {
    if (!this.accepting || this.running.has(jobId)) return;
    const task = this.run(jobId)
      .catch(() => {
        this.blocked = true;
        this.accepting = false;
      })
      .finally(() => {
        this.running.delete(jobId);
        if (this.ownerRequestedReruns.delete(jobId)) this.schedule(jobId);
      });
    this.running.set(jobId, task);
  }

  status(): { blocked: boolean; queued: number; running: number } {
    const queued = this.store
      .listJobs()
      .filter((job) => job.state.kind === "queued" || job.state.kind === "preparing").length;
    return { blocked: this.blocked, queued, running: this.running.size };
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  resume(jobId: string): StoredJob {
    const job = this.store.getJob(jobId);
    assertGenericJobOperation(job, "resume");
    return this.resumeAuthorized(job);
  }

  resumeBatch(jobId: string, owner: JobSpec["owner"]): StoredJob {
    const job = this.store.getJob(jobId);
    assertBatchJobOperation(job, owner, "resume");
    return this.resumeAuthorized(job);
  }

  private resumeAuthorized(job: StoredJob): StoredJob {
    if ((this.allowDispatch && needsDispatchLane(job)) || needsCaptureLane(job)) {
      if (this.running.has(job.id)) this.ownerRequestedReruns.add(job.id);
      else this.schedule(job.id);
      return job;
    }
    throw new JobOperationConflictError(job.id, "resume", job.state.kind);
  }

  abandon(jobId: string, reason: string): StoredJob {
    const job = this.store.getJob(jobId);
    assertGenericJobOperation(job, "abandon");
    return this.abandonAuthorized(job, reason);
  }

  abandonBatch(jobId: string, owner: JobSpec["owner"], reason: string): StoredJob {
    const job = this.store.getJob(jobId);
    assertBatchJobOperation(job, owner, "abandon");
    return this.abandonAuthorized(job, reason);
  }

  private abandonAuthorized(job: StoredJob, reason: string): StoredJob {
    if (this.running.has(job.id)) {
      throw new JobOperationConflictError(job.id, "abandon while active", job.state.kind);
    }
    if (job.state.kind === "queued") {
      return this.append(job, { type: "job-canceled-unsent", reason });
    }
    if (
      job.state.kind === "committed" ||
      job.state.kind === "capturing" ||
      job.state.kind === "recoverable" ||
      job.state.kind === "ambiguous"
    ) {
      return this.append(job, { type: "job-abandoned", reason });
    }
    throw new JobOperationConflictError(job.id, "abandon", job.state.kind);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(this.running.values());
  }

  private async run(jobId: string): Promise<void> {
    try {
      let job = this.store.getJob(jobId);
      if (this.allowDispatch && needsDispatchLane(job)) {
        await this.dispatchMutex.run(async () => {
          await this.advanceToCommitted(jobId);
        });
        job = this.store.getJob(jobId);
      }
      if (needsCaptureLane(job)) {
        await this.captureSemaphore.run(async () => {
          await this.capture(jobId);
        });
      }
    } finally {
      await this.provider.releaseJob?.(jobId);
    }
  }

  private async advanceToCommitted(jobId: string): Promise<void> {
    while (true) {
      const job = this.store.getJob(jobId);
      switch (job.state.kind) {
        case "queued":
          if (job.state.blockedBy) return;
          this.append(job, { type: "preparation-started", attempt: 1 });
          break;
        case "preparing": {
          try {
            const receipt = await this.provider.prepare(context(job));
            this.append(job, { type: "preparation-completed", receipt });
            this.faultInjector.hit("after-preparation", faultContext(job));
          } catch (error) {
            this.append(job, {
              type: "preparation-failed",
              failure: failure(
                "preparation_failed",
                "preparation",
                "none",
                "safe-new-attempt",
                error,
              ),
            });
          }
          break;
        }
        case "ready-to-dispatch": {
          const intent = createIntent(job);
          this.append(job, { type: "dispatch-reserved", intent });
          this.faultInjector.hit("after-dispatch-reserved", faultContext(job));
          break;
        }
        case "dispatch-reserved": {
          let atRisk: StoredJob;
          try {
            await this.provider.verifyPrepared(context(job), job.state.preparation);
            atRisk = this.append(job, {
              type: "dispatch-marked-at-risk",
              atRiskAt: new Date().toISOString(),
            });
            this.faultInjector.hit("after-dispatch-at-risk", faultContext(job));
          } catch (error) {
            this.append(job, {
              type: "preparation-failed",
              failure: failure(
                "final_verification_failed",
                "final-verification",
                "none",
                "safe-new-attempt",
                error,
              ),
            });
            break;
          }
          if (atRisk.state.kind !== "dispatch-at-risk") throw new Error("Expected at-risk state");
          let dispatchError: unknown;
          try {
            await this.provider.dispatchOnce({ ...context(atRisk), intent: atRisk.state.intent });
          } catch (error) {
            dispatchError = error;
          }
          this.faultInjector.hit("immediately-after-click", faultContext(job));
          await this.commitObserved(atRisk, dispatchError);
          break;
        }
        case "dispatch-at-risk":
          await this.commitObserved(job);
          break;
        case "committed":
        case "capturing":
        case "completed":
        case "recoverable":
        case "ambiguous":
        case "failed-unsent":
        case "canceled-unsent":
        case "abandoned":
          return;
      }
    }
  }

  private async commitObserved(job: StoredJob, dispatchError?: unknown): Promise<void> {
    if (job.state.kind !== "dispatch-at-risk")
      throw new Error("Commit observation requires at-risk state");
    try {
      const receipt = await this.provider.observeCommit({
        ...context(job),
        intent: job.state.intent,
      });
      if (receipt) {
        this.faultInjector.hit("after-commit-observed", faultContext(job));
        this.append(job, { type: "submission-committed", receipt });
        this.faultInjector.hit("after-submission-receipt", faultContext(job));
        return;
      }
      this.append(job, {
        type: "dispatch-ambiguous",
        failure: failure(
          dispatchError ? "dispatch_failed_commit_not_found" : "commit_not_found",
          "commit-recovery",
          "possible",
          "owner-required",
          dispatchError,
        ),
      });
    } catch (error) {
      this.append(job, {
        type: "dispatch-ambiguous",
        failure: failure(
          "commit_observation_failed",
          "commit-recovery",
          "possible",
          "owner-required",
          error,
        ),
      });
    }
  }

  private async capture(jobId: string): Promise<void> {
    let job = this.store.getJob(jobId);
    if (
      job.state.kind === "committed" ||
      (job.state.kind === "recoverable" && job.state.basis === "committed-capture")
    ) {
      job = this.append(job, { type: "capture-started", attempt: 1 });
    }
    if (job.state.kind !== "capturing") return;
    try {
      this.faultInjector.hit("during-capture", faultContext(job));
      const result = await this.provider.capture({
        ...context(job),
        submission: job.state.submission,
      });
      const answer = this.store.putObject(result.answerBytes, {
        mediaType: result.mediaType,
        objectClass: "answer",
        expectedSha256: result.receipt.responseSha256,
      });
      const representations = new Map<string, ObjectRef>([[answer.sha256, answer]]);
      const putRepresentation = (
        bytes: Uint8Array,
        metadata: { mediaType: string; objectClass: "text" | "html" },
      ): ObjectRef => {
        const digest = sha256(bytes);
        const existing = representations.get(digest);
        if (existing) return existing;
        const ref = this.store.putObject(bytes, metadata);
        representations.set(digest, ref);
        return ref;
      };
      const plainText = putRepresentation(result.plainTextBytes, {
        mediaType: "text/plain",
        objectClass: "text",
      });
      const html = putRepresentation(result.htmlBytes, {
        mediaType: "text/html",
        objectClass: "html",
      });
      this.store.linkJobObject(job.id, "response-plain", plainText, "authority");
      this.store.linkJobObject(job.id, "response-html", html, "authority");
      this.faultInjector.hit("after-answer-object-write", faultContext(job));
      this.faultInjector.hit("before-completed-event", faultContext(job));
      this.append(job, { type: "capture-completed", receipt: result.receipt, answer });
    } catch (error) {
      this.append(job, {
        type: "capture-failed",
        failure: failure("capture_failed", "capture", "committed", "capture-only", error),
      });
    }
  }

  private append(job: StoredJob, event: JobEventInput): StoredJob {
    return this.store.appendEvent(job.id, job.stateVersion, {
      schemaVersion: JOB_EVENT_SCHEMA_VERSION,
      ...event,
    } as JobEvent);
  }
}

function assertGenericJobOperation(job: StoredJob, operation: "resume" | "abandon"): void {
  if (job.spec.owner.kind === "batch-lane" || job.spec.owner.kind === "batch-synthesis") {
    throw new JobOperationConflictError(
      job.id,
      `${operation} batch-owned job outside its parent`,
      job.state.kind,
    );
  }
}

function assertBatchJobOperation(
  job: StoredJob,
  owner: JobSpec["owner"],
  operation: "resume" | "abandon",
): void {
  if (job.spec.owner.kind !== "batch-lane" && job.spec.owner.kind !== "batch-synthesis") {
    throw new JobOperationConflictError(
      job.id,
      `${operation} non-batch job through its Batch parent`,
      job.state.kind,
    );
  }
  if (JSON.stringify(job.spec.owner) !== JSON.stringify(owner)) {
    throw new JobOperationConflictError(
      job.id,
      `${operation} batch-owned job with mismatched parent identity`,
      job.state.kind,
    );
  }
}

function needsDispatchLane(job: StoredJob): boolean {
  return [
    "queued",
    "preparing",
    "ready-to-dispatch",
    "dispatch-reserved",
    "dispatch-at-risk",
  ].includes(job.state.kind);
}

function needsCaptureLane(job: StoredJob): boolean {
  return (
    job.state.kind === "committed" ||
    job.state.kind === "capturing" ||
    (job.state.kind === "recoverable" && job.state.basis === "committed-capture")
  );
}

function context(job: StoredJob) {
  return { jobId: job.id, spec: job.spec, state: job.state, stateVersion: job.stateVersion };
}

function faultContext(job: StoredJob): WorkerFaultContext {
  return { jobId: job.id, requestId: job.spec.requestId };
}

function createIntent(job: StoredJob): DispatchIntent {
  if (job.state.kind !== "ready-to-dispatch") {
    throw new Error(`Dispatch intent requires ready-to-dispatch state, received ${job.state.kind}`);
  }
  const turnAttemptId = `${job.id}-turn-${job.stateVersion + 1}`;
  const bundle = job.spec.input.bundleSha256;
  return {
    jobId: job.id,
    turnAttemptId,
    promptSha256: job.spec.input.promptSha256,
    ...(bundle ? { bundleSha256: bundle } : {}),
    baselineConversationDigest: job.state.preparation.baselineConversationDigest,
    baselineTurnCount: job.state.preparation.baselineTurnCount,
    receiptFooter: `[Oracle receipt: job=${job.id}; turn=${turnAttemptId}; prompt=${job.spec.input.promptSha256.slice(0, 12)}; bundle=${bundle?.slice(0, 12) ?? "none"}]`,
    reservedAt: new Date().toISOString(),
  };
}

function failure(
  code: string,
  phase: string,
  externalEffectRisk: FailureReceipt["externalEffectRisk"],
  retryPolicy: FailureReceipt["retryPolicy"],
  cause?: unknown,
): FailureReceipt {
  return {
    code,
    phase,
    message: cause instanceof Error ? cause.message : code,
    occurredAt: new Date().toISOString(),
    externalEffectRisk,
    retryPolicy,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
