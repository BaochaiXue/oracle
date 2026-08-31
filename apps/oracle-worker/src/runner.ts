import {
  JOB_EVENT_SCHEMA_VERSION,
  type DispatchIntent,
  type FailureReceipt,
  type JobEvent,
  type ProviderAdapter,
} from "../../../packages/oracle-kernel/src/index.js";
import { OracleStore, type StoredJob } from "../../../packages/oracle-store/src/index.js";
import { Mutex, Semaphore } from "./synchronization.js";

export type WorkerFaultPoint = "after-provider-dispatch";

export interface JobRunnerOptions {
  store: OracleStore;
  provider: ProviderAdapter;
  faultAt?: WorkerFaultPoint;
  maxConcurrentCaptures?: number;
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
  private readonly faultAt?: WorkerFaultPoint;
  private readonly dispatchMutex = new Mutex();
  private readonly captureSemaphore: Semaphore;
  private readonly running = new Map<string, Promise<void>>();
  private readonly ownerRequestedReruns = new Set<string>();
  private accepting = true;
  private blocked = false;

  constructor(options: JobRunnerOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.faultAt = options.faultAt;
    this.captureSemaphore = new Semaphore(options.maxConcurrentCaptures ?? 3);
  }

  recover(): void {
    for (let job of this.store.listJobs()) {
      if (job.state.kind === "preparing") {
        job = this.append(job, { type: "preparation-deferred" });
      }
      if (needsDispatchLane(job) || needsCaptureLane(job)) this.schedule(job.id);
    }
  }

  schedule(jobId: string): void {
    if (!this.accepting || this.running.has(jobId)) return;
    const task = this.run(jobId)
      .catch((error) => {
        this.blocked = true;
        this.accepting = false;
        if (error instanceof SimulatedWorkerCrash) return;
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
    if (needsDispatchLane(job) || needsCaptureLane(job)) {
      if (this.running.has(job.id)) this.ownerRequestedReruns.add(job.id);
      else this.schedule(job.id);
      return job;
    }
    throw new JobOperationConflictError(job.id, "resume", job.state.kind);
  }

  abandon(jobId: string, reason: string): StoredJob {
    const job = this.store.getJob(jobId);
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
    let job = this.store.getJob(jobId);
    if (needsDispatchLane(job)) {
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
          if (this.faultAt === "after-provider-dispatch") throw new SimulatedWorkerCrash();
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
        this.append(job, { type: "submission-committed", receipt });
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
      const result = await this.provider.capture({
        ...context(job),
        submission: job.state.submission,
      });
      const answer = this.store.putObject(result.answerBytes, {
        mediaType: result.mediaType,
        objectClass: "answer",
        expectedSha256: result.receipt.responseSha256,
      });
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
  return { jobId: job.id, spec: job.spec, state: job.state };
}

function createIntent(job: StoredJob): DispatchIntent {
  const turnAttemptId = `${job.id}-turn-${job.stateVersion + 1}`;
  const bundle = job.spec.input.bundleSha256;
  return {
    jobId: job.id,
    turnAttemptId,
    promptSha256: job.spec.input.promptSha256,
    ...(bundle ? { bundleSha256: bundle } : {}),
    baselineConversationDigest: `baseline-${job.id}-${job.stateVersion}`,
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

class SimulatedWorkerCrash extends Error {}
