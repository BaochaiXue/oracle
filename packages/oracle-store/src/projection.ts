import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  JOB_SCHEMA_VERSION,
  type JobSpec,
  type JobState,
  type ObjectRef,
} from "../../oracle-kernel/src/index.js";
import { ensurePrivateDirectory } from "./cas.js";

export interface ProjectionEvent {
  seq: number;
  type: string;
  event: unknown;
  createdAt: string;
}

export interface ProjectionJob {
  id: string;
  spec: JobSpec;
  specObjectSha256: string;
  state: JobState;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class SessionProjector {
  readonly sessionsDir: string;
  readonly readObject: (ref: ObjectRef) => Buffer;

  constructor(sessionsDir: string, readObject: (ref: ObjectRef) => Buffer) {
    this.sessionsDir = sessionsDir;
    this.readObject = readObject;
    ensurePrivateDirectory(sessionsDir);
  }

  pathFor(jobId: string): string {
    requireSafeSegment(jobId);
    return path.join(this.sessionsDir, jobId);
  }

  write(job: ProjectionJob, events: ProjectionEvent[]): void {
    const directory = this.pathFor(job.id);
    ensurePrivateDirectory(directory);
    ensurePrivateDirectory(path.join(directory, "artifacts"));
    const prompt = this.readObject(job.spec.input.prompt);
    atomicWrite(path.join(directory, "prompt.md"), prompt);

    if (job.state.kind === "completed") {
      atomicWrite(path.join(directory, "response.md"), this.readObject(job.state.answer));
    }

    const metadata = {
      schemaVersion: JOB_SCHEMA_VERSION,
      projectionSchemaVersion: "oracle.session-projection.v2",
      jobId: job.id,
      requestId: job.spec.requestId,
      owner: job.spec.owner,
      state: job.state,
      stateVersion: job.stateVersion,
      specObjectSha256: job.specObjectSha256,
      promptSha256: job.spec.input.promptSha256,
      bundleSha256: job.spec.input.bundleSha256 ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
    atomicWrite(path.join(directory, "meta.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const log = events
      .map((item) =>
        JSON.stringify({
          seq: item.seq,
          type: item.type,
          createdAt: item.createdAt,
          event: item.event,
        }),
      )
      .join("\n");
    atomicWrite(path.join(directory, "log.jsonl"), log ? `${log}\n` : "");
  }
}

function atomicWrite(destination: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function requireSafeSegment(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Unsafe projection job id: ${value}`);
  }
}
