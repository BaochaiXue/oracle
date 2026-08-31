export const WORKER_FAULT_POINTS = [
  "after-job-admission",
  "after-preparation",
  "after-dispatch-reserved",
  "after-dispatch-at-risk",
  "immediately-after-click",
  "after-commit-observed",
  "after-submission-receipt",
  "during-capture",
  "after-answer-object-write",
  "before-completed-event",
] as const;

export type WorkerFaultPoint = (typeof WORKER_FAULT_POINTS)[number];

export interface WorkerFaultInjector {
  hit(point: WorkerFaultPoint): void;
}

export class EnvironmentHardExitFaultInjector implements WorkerFaultInjector {
  private readonly configured: WorkerFaultPoint | undefined;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const requested = environment.ORACLE_FAULT_AT;
    this.configured =
      environment.ORACLE_V2_TEST_FAULTS === "1" &&
      WORKER_FAULT_POINTS.includes(requested as WorkerFaultPoint)
        ? (requested as WorkerFaultPoint)
        : undefined;
  }

  hit(point: WorkerFaultPoint): void {
    if (point === this.configured) process.exit(86);
  }
}
