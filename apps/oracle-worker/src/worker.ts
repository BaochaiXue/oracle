import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  objectRefSchema,
  parseJobSpec,
  type ProviderAdapter,
} from "../../../packages/oracle-kernel/src/index.js";
import { OracleStore } from "../../../packages/oracle-store/src/index.js";
import { EnvironmentHardExitFaultInjector, type WorkerFaultInjector } from "./faults.js";
import { JobOperationConflictError, JobRunner } from "./runner.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEBUG_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const DEBUG_MAX_BYTES = 512 * 1024 * 1024;

export interface OracleWorkerOptions {
  rootDir: string;
  sessionsDir: string;
  socketPath: string;
  provider: ProviderAdapter;
  faultInjector?: WorkerFaultInjector;
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
  private readonly faultInjector: WorkerFaultInjector;
  private store?: OracleStore;
  private runner?: JobRunner;
  private server?: http.Server;
  private ownedSocket?: SocketIdentity;
  private ready = false;
  private providerStatus: "compatible" | "incompatible" = "incompatible";

  constructor(options: OracleWorkerOptions) {
    this.options = options;
    this.faultInjector = options.faultInjector ?? new EnvironmentHardExitFaultInjector();
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Oracle v2 worker is already started");
    const socketDir = path.dirname(this.options.socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    chmodSync(socketDir, 0o700);
    const existingSocket = socketIdentity(this.options.socketPath);
    if (existingSocket) {
      if (await socketIsOwned(this.options.socketPath)) {
        throw new WorkerAlreadyRunningError(this.options.socketPath);
      }
      if (!unlinkSocketIfOwned(this.options.socketPath, existingSocket)) {
        throw new WorkerAlreadyRunningError(this.options.socketPath);
      }
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
      store.pruneDebugObjects({ ttlMs: DEBUG_TTL_MS, maxBytes: DEBUG_MAX_BYTES, keepLatest: 0 });
      this.options.provider.bindRuntime?.({ readObject: (ref) => store!.readObject(ref) });
      const compatibility = await this.options.provider.probe();
      const providerStatus = store.setProviderStatus("chatgpt-web", compatibility);
      const runner = new JobRunner({
        store,
        provider: this.options.provider,
        allowDispatch: providerStatus.state === "compatible",
        faultInjector: this.faultInjector,
      });
      this.store = store;
      this.runner = runner;
      this.server = server;
      this.ownedSocket = boundSocket;
      this.providerStatus = providerStatus.state;
      this.ready = true;
      runner.recover();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      const storeToClose = store;
      if (storeToClose) {
        await collectCleanupError(cleanupErrors, () => storeToClose.close());
      }
      if (this.options.provider.close) {
        await collectCleanupError(cleanupErrors, () => this.options.provider.close!());
      }
      if (didBind) {
        await collectCleanupError(cleanupErrors, () => closeServer(server));
        await collectCleanupError(cleanupErrors, () => {
          unlinkSocketIfOwned(this.options.socketPath, boundSocket);
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Oracle v2 worker startup and cleanup both failed",
        );
      }
      if (isAddressInUse(error)) throw new WorkerAlreadyRunningError(this.options.socketPath);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    const runner = this.runner;
    const server = this.server;
    const store = this.store;
    const ownedSocket = this.ownedSocket;
    const cleanupErrors: unknown[] = [];
    if (runner) await collectCleanupError(cleanupErrors, () => runner.stop());
    if (this.options.provider.close) {
      await collectCleanupError(cleanupErrors, () => this.options.provider.close!());
    }
    if (server) await collectCleanupError(cleanupErrors, () => closeServer(server));
    if (store) await collectCleanupError(cleanupErrors, () => store.close());
    await collectCleanupError(cleanupErrors, () => {
      unlinkSocketIfOwned(this.options.socketPath, ownedSocket);
    });
    this.server = undefined;
    this.runner = undefined;
    this.store = undefined;
    this.ownedSocket = undefined;
    this.providerStatus = "incompatible";
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Oracle v2 worker cleanup failed");
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://oracle.local");
      if (request.method === "GET" && url.pathname === "/v2/worker") {
        if (!this.store || !this.runner) {
          sendJson(response, 200, {
            phase: "starting",
            ready: false,
            provider: "incompatible",
            blocked: true,
            queued: 0,
            running: 0,
          });
          return;
        }
        const runner = this.runner;
        const status = runner.status();
        sendJson(response, 200, {
          phase: "ready",
          ready: this.ready && !status.blocked,
          provider: this.providerStatus,
          ...status,
        });
        return;
      }
      const store = this.requireStore();
      const runner = this.requireRunner();
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
        const admission = store.admitJob(
          spec,
          this.providerStatus === "incompatible" ? { blockedBy: "provider" } : {},
        );
        this.faultInjector.hit("after-job-admission", {
          jobId: admission.job.id,
          requestId: admission.job.spec.requestId,
        });
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
        const admission = store.admitJob(
          spec,
          this.providerStatus === "incompatible" ? { blockedBy: "provider" } : {},
        );
        this.faultInjector.hit("after-job-admission", {
          jobId: admission.job.id,
          requestId: admission.job.spec.requestId,
        });
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
      const resultMatch = url.pathname.match(/^\/v2\/jobs\/([^/]+)\/result$/u);
      if (request.method === "GET" && resultMatch) {
        const job = store.getJob(decodeURIComponent(resultMatch[1]!));
        if (job.state.kind !== "completed") {
          sendJson(response, 200, { jobId: job.id, state: job.state.kind, ready: false });
          return;
        }
        sendJson(response, 200, {
          jobId: job.id,
          state: job.state.kind,
          ready: true,
          answer: job.state.answer,
          text: store.readObject(job.state.answer).toString("utf8"),
          mediaType: job.state.answer.mediaType,
        });
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

function socketIsOwned(socketPath: string): Promise<boolean> {
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

function unlinkSocketIfOwned(socketPath: string, owned: SocketIdentity | undefined): boolean {
  if (!owned) return socketIdentity(socketPath) === undefined;
  const current = socketIdentity(socketPath);
  if (!current) return true;
  if (current.device !== owned.device || current.inode !== owned.inode) return false;
  unlinkSync(socketPath);
  return true;
}

async function collectCleanupError(
  errors: unknown[],
  cleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
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
