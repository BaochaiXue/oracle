import http from "node:http";
import type { JobSpec, JobStateKind, ObjectRef } from "../../oracle-kernel/src/index.js";
import type {
  ClientAdmission,
  ClientEvent,
  ClientJob,
  ClientJobResult,
  PutClientObjectOptions,
  WaitOptions,
  WorkerStatus,
} from "./types.js";

export interface OracleClientOptions {
  socketPath: string;
}

export class OracleClient {
  readonly socketPath: string;
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

  constructor(options: OracleClientOptions) {
    this.socketPath = options.socketPath;
  }

  close(): void {
    this.agent.destroy();
  }

  async putObject<T extends ObjectRef["objectClass"]>(
    bytes: Uint8Array,
    options: PutClientObjectOptions<T>,
  ): Promise<Omit<ObjectRef, "objectClass"> & { objectClass: T }> {
    const digest = await sha256(bytes);
    return this.request(`/v2/objects/sha256/${digest}`, {
      method: "PUT",
      body: Buffer.from(bytes),
      headers: {
        "content-type": options.mediaType,
        "x-oracle-object-class": options.objectClass,
      },
    });
  }

  admitJob(spec: JobSpec): Promise<ClientAdmission> {
    return this.request("/v2/jobs", { method: "POST", json: spec });
  }

  getJob(jobId: string): Promise<ClientJob> {
    return this.request(`/v2/jobs/${encodeURIComponent(jobId)}`);
  }

  getResult(jobId: string): Promise<ClientJobResult> {
    return this.request(`/v2/jobs/${encodeURIComponent(jobId)}/result`);
  }

  listJobs(): Promise<ClientJob[]> {
    return this.request("/v2/jobs");
  }

  resumeJob(jobId: string): Promise<ClientJob> {
    return this.request(`/v2/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST" });
  }

  abandonJob(jobId: string, reason: string): Promise<ClientJob> {
    return this.request(`/v2/jobs/${encodeURIComponent(jobId)}/abandon`, {
      method: "POST",
      json: { reason },
    });
  }

  admitCanary(spec: JobSpec): Promise<ClientAdmission> {
    return this.request("/v2/canary", { method: "POST", json: spec });
  }

  getWorker(): Promise<WorkerStatus> {
    return this.request("/v2/worker");
  }

  async listEvents(jobId: string, options: { after?: number } = {}): Promise<ClientEvent[]> {
    const response = await this.rawRequest(
      `/v2/jobs/${encodeURIComponent(jobId)}/events?after=${options.after ?? 0}`,
      { method: "GET" },
    );
    const text = response.body.toString("utf8").trim();
    return text ? text.split("\n").map((line) => JSON.parse(line) as ClientEvent) : [];
  }

  async waitForTerminal(jobId: string, options: WaitOptions): Promise<ClientJob> {
    const terminal = new Set<JobStateKind>([
      "completed",
      "failed-unsent",
      "canceled-unsent",
      "abandoned",
      "ambiguous",
    ]);
    return this.waitFor(jobId, (job) => terminal.has(job.state.kind), options);
  }

  async waitForState(jobId: string, state: JobStateKind, options: WaitOptions): Promise<ClientJob> {
    return this.waitFor(jobId, (job) => job.state.kind === state, options);
  }

  private async waitFor(
    jobId: string,
    predicate: (job: ClientJob) => boolean,
    options: WaitOptions,
  ): Promise<ClientJob> {
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      const job = await this.getJob(jobId);
      if (predicate(job)) return job;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Oracle v2 job ${jobId}; current state ${job.state.kind}`,
        );
      }
      await delay(options.pollMs ?? 10);
    }
  }

  private async request<T>(
    requestPath: string,
    options: {
      method?: string;
      body?: Uint8Array;
      json?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const response = await this.rawRequest(requestPath, options);
    return JSON.parse(response.body.toString("utf8")) as T;
  }

  private rawRequest(
    requestPath: string,
    options: {
      method?: string;
      body?: Uint8Array;
      json?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; body: Buffer }> {
    const body =
      options.json === undefined ? options.body : Buffer.from(JSON.stringify(options.json));
    const headers = {
      ...(options.json === undefined ? {} : { "content-type": "application/json" }),
      ...(body ? { "content-length": String(body.byteLength) } : {}),
      ...options.headers,
    };
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: requestPath,
          method: options.method ?? "GET",
          headers,
          agent: this.agent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const responseBody = Buffer.concat(chunks);
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              reject(new Error(`Oracle worker HTTP ${status}: ${responseBody.toString("utf8")}`));
              return;
            }
            resolve({ status, body: responseBody });
          });
        },
      );
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
