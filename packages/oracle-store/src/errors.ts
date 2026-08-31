export class ObjectIntegrityError extends Error {
  readonly sha256: string;

  constructor(sha256: string, message: string) {
    super(`Object ${sha256} failed integrity verification: ${message}`);
    this.name = "ObjectIntegrityError";
    this.sha256 = sha256;
  }
}

export class StateVersionConflictError extends Error {
  readonly jobId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(jobId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Job ${jobId} state version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "StateVersionConflictError";
    this.jobId = jobId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export type StoreFaultPoint = "after-event-insert" | "after-state-update";

export class StoreFaultError extends Error {
  readonly point: StoreFaultPoint;

  constructor(point: StoreFaultPoint) {
    super(`Injected Oracle store fault at ${point}`);
    this.name = "StoreFaultError";
    this.point = point;
  }
}

export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}
