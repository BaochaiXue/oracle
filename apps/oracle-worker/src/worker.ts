import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  objectRefSchema,
  parseJobSpec,
  type ProviderAdapter,
} from "../../../packages/oracle-kernel/src/index.js";
import { OracleStore } from "../../../packages/oracle-store/src/index.js";
import { JobOperationConflictError, JobRunner, type WorkerFaultPoint } from "./runner.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface OracleWorkerOptions {
  rootDir: string;
  sessionsDir: string;
  socketPath: string;
  provider: ProviderAdapter;
  faultAt?: WorkerFaultPoint;
}

export class WorkerAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`Oracle v2 worker already owns ${socketPath}`);
    this.name = "WorkerAlreadyRunningError";
  }
}

class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export class OracleWorker {
  readonly options: OracleWorkerOptions;
  private store?: OracleStore;
  private runner?: JobRunner;
  private server?: http.Server;
  private ownedSocket?: SocketIdentity;
  private ready = false;

  constructor(options: OracleWorkerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Oracle v2 worker is already started");
    const socketDir = path.dirname(this.options.socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    chmodSync(socketDir, 0o700);
    if (existsSync(this.options.socketPath)) {
      if (await socketIsHealthy(this.options.socketPath)) {
        throw new WorkerAlreadyRunningError(this.options.socketPath);
      }
      const staleSocket = socketIdentity(this.options.socketPath);
      unlinkSocketIfOwned(this.options.socketPath, staleSocket);
    }

    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    let store: OracleStore | undefined;
    let boundSocket: SocketIdentity | undefined;
    let didBind = false;
    try {
      await listen(server, this.options.socketPath);
      didBind = true;
      chmodSync(this.options.socketPath, 0o600);
      boundSocket = socketIdentity(this.options.socketPath);
      store = new OracleStore({
        rootDir: this.options.rootDir,
        sessionsDir: this.options.sessionsDir,
      });
      const runner = new JobRunner({
        store,
        provider: this.options.provider,
        ...(this.options.faultAt ? { faultAt: this.options.faultAt } : {}),
      });
      this.store = store;
      this.runner = runner;
      this.server = server;
      this.ownedSocket = boundSocket;
      this.ready = true;
      runner.recover();
    } catch (error) {
      store?.close();
      if (didBind) {
        await closeServer(server).catch(() => undefined);
        unlinkSocketIfOwned(this.options.socketPath, boundSocket);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.runner) await this.runner.stop();
    if (this.server) await closeServer(this.server);
    this.store?.close();
    unlinkSocketIfOwned(this.options.socketPath, this.ownedSocket);
    this.server = undefined;
    this.runner = undefined;
    this.store = undefined;
    this.ownedSocket = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const store = this.requireStore();
      const runner = this.requireRunner();
      const url = new URL(request.url ?? "/", "http://oracle.local");
      if (request.method === "GET" && url.pathname === "/v2/worker") {
        const status = runner.status();
        sendJson(response, 200, { ready: this.ready && !status.blocked, ...status });
        return;
      }
      if (request.method !== "GET" && (!this.ready || runner.isBlocked())) {
        sendJson(response, 503, { error: "worker_not_ready" });
        return;
      }
      if (request.method === "PUT" && url.pathname.startsWith("/v2/objects/sha256/")) {
        const expectedSha256 = decodeURIComponent(url.pathname.slice("/v2/objects/sha256/".length));
        const objectClass = request.headers["x-oracle-object-class"];
        const mediaType = request.headers["content-type"];
        if (typeof objectClass !== "string" || typeof mediaType !== "string") {
          sendJson(response, 400, { error: "object_metadata_required" });
          return;
        }
        const bytes = await readBody(request);
        const parsedRef = objectRefSchema.parse({
          sha256: expectedSha256,
          sizeBytes: bytes.byteLength,
          mediaType,
          objectClass,
        });
        const ref = store.putObject(bytes, {
          expectedSha256,
          mediaType,
          objectClass: parsedRef.objectClass,
        });
        sendJson(response, 200, ref);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/jobs") {
        const spec = parseJobSpec(JSON.parse((await readBody(request)).toString("utf8")));
        const admission = store.admitJob(spec);
        if (!admission.specMatches) {
          sendJson(response, 409, {
            error: "idempotency_spec_conflict",
            jobId: admission.job.id,
          });
          return;
        }
        runner.schedule(admission.job.id);
        sendJson(response, admission.created ? 201 : 200, admission);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/canary") {
        const spec = parseJobSpec(JSON.parse((await readBody(request)).toString("utf8")));
        if (spec.owner.kind !== "canary") {
          sendJson(response, 400, { error: "canary_owner_required" });
          return;
        }
        const admission = store.admitJob(spec);
        if (!admission.specMatches) {
          sendJson(response, 409, {
            error: "idempotency_spec_conflict",
            jobId: admission.job.id,
          });
          return;
        }
        runner.schedule(admission.job.id);
        sendJson(response, admission.created ? 201 : 200, admission);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v2/jobs") {
        sendJson(response, 200, store.listJobs());
        return;
      }
      const eventMatch = url.pathname.match(/^\/v2\/jobs\/([^/]+)\/events$/u);
      if (request.method === "GET" && eventMatch) {
        const jobId = decodeURIComponent(eventMatch[1]!);
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          throw new RequestValidationError("Event cursor must be a non-negative integer");
        }
        const events = store.listEvents(jobId).filter((item) => item.seq > after);
        response.statusCode = 200;
        response.setHeader("content-type", "application/x-ndjson");
        response.end(
          events.map((item) => JSON.stringify(item)).join("\n") + (events.length ? "\n" : ""),
        );
        return;
      }
      const resumeMatch = url.pathname.match(/^\/v2\/jobs\/([^/]+)\/resume$/u);
      if (request.method === "POST" && resumeMatch) {
        sendJson(response, 200, runner.resume(decodeURIComponent(resumeMatch[1]!)));
        return;
      }
      const abandonMatch = url.pathname.match(/^\/v2\/jobs\/([^/]+)\/abandon$/u);
      if (request.method === "POST" && abandonMatch) {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
        const reason = parseReason(body);
        sendJson(response, 200, runner.abandon(decodeURIComponent(abandonMatch[1]!), reason));
        return;
      }
      const jobMatch = url.pathname.match(/^\/v2\/jobs\/([^/]+)$/u);
      if (request.method === "GET" && jobMatch) {
        sendJson(response, 200, store.getJob(decodeURIComponent(jobMatch[1]!)));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = httpStatus(error);
      sendJson(response, status, {
        error: "worker_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireStore(): OracleStore {
    if (!this.store) throw new Error("Oracle v2 store is not ready");
    return this.store;
  }

  private requireRunner(): JobRunner {
    if (!this.runner) throw new Error("Oracle v2 runner is not ready");
    return this.runner;
  }
}

function listen(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function socketIsHealthy(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (owned: boolean) => {
      if (settled) return;
      settled = true;
      resolve(owned);
    };
    const request = http.request({ socketPath, path: "/v2/worker", method: "GET" }, (response) => {
      response.resume();
      finish(true);
    });
    request.setTimeout(1_000, () => {
      request.destroy();
      finish(true);
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

interface SocketIdentity {
  device: number;
  inode: number;
}

function socketIdentity(socketPath: string): SocketIdentity | undefined {
  try {
    const stat = lstatSync(socketPath);
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function unlinkSocketIfOwned(socketPath: string, owned: SocketIdentity | undefined): void {
  if (!owned) return;
  const current = socketIdentity(socketPath);
  if (!current || current.device !== owned.device || current.inode !== owned.inode) return;
  unlinkSync(socketPath);
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseReason(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestValidationError("Abandon requires a reason");
  }
  const reason = (input as Record<string, unknown>).reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new RequestValidationError("Abandon requires a reason");
  }
  return reason.trim();
}

function httpStatus(error: unknown): number {
  if (error instanceof JobOperationConflictError) return 409;
  if (
    error instanceof RequestValidationError ||
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === "ZodError")
  ) {
    return 400;
  }
  if (error instanceof Error && error.message === "request_too_large") return 413;
  if (error instanceof Error && error.message.startsWith("Unknown Oracle v2 job:")) return 404;
  return 500;
}
