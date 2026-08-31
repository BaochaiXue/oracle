import type { JobSpec, JobState, ObjectRef } from "../../oracle-kernel/src/index.js";

export interface ClientJob {
  id: string;
  spec: JobSpec;
  specObjectSha256: string;
  state: JobState;
  stateVersion: number;
  projectionPending: boolean;
  projectionError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientAdmission {
  created: boolean;
  specMatches: boolean;
  job: ClientJob;
}

export interface ClientEvent {
  seq: number;
  type: string;
  event: unknown;
  createdAt: string;
}

export interface WorkerStatus {
  ready: boolean;
  blocked: boolean;
  queued: number;
  running: number;
}

export interface PutClientObjectOptions<T extends ObjectRef["objectClass"]> {
  mediaType: string;
  objectClass: T;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
}
