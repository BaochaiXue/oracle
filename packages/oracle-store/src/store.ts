import { chmodSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  initialJobState,
  compatibilityReceiptSchema,
  objectRefSchema,
  parseJobEvent,
  parseJobSpec,
  parseJobState,
  reduceJob,
  validateJobState,
  type JobEvent,
  type JobSpec,
  type JobState,
  type CompatibilityReceipt,
  type ObjectRef,
} from "../../oracle-kernel/src/index.js";
import {
  ContentAddressedStore,
  digest,
  ensurePrivateDirectory,
  type PutObjectOptions,
  type TypedObjectRef,
} from "./cas.js";
import {
  StateVersionConflictError,
  StorageIntegrityError,
  StoreFaultError,
  type StoreFaultPoint,
} from "./errors.js";
import { runMigrations } from "./migrations.js";
import { SessionProjector, type ProjectionEvent } from "./projection.js";

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

export interface OracleStoreOptions {
  rootDir: string;
  sessionsDir: string;
  now?: () => Date;
  idGenerator?: () => string;
  backupRetention?: number;
}

export interface StoredJob {
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

export interface AdmissionResult {
  created: boolean;
  specMatches: boolean;
  job: StoredJob;
}

export interface StoredEvent extends ProjectionEvent {}

export interface AppendEventOptions {
  faultAt?: StoreFaultPoint;
}

export interface DebugPruneOptions {
  ttlMs: number;
  maxBytes: number;
  keepLatest: number;
}

export interface DebugPruneResult {
  deleted: number;
  pinned: number;
  retainedBytes: number;
}

export interface StorageVerification {
  database: "ok" | string;
  checkedObjects: number;
  objectErrors: { sha256: string; message: string }[];
  ledgerErrors: { jobId: string; message: string }[];
}

export interface ProviderStatusRecord {
  provider: "chatgpt-web";
  state: "compatible" | "incompatible";
  receipt: CompatibilityReceipt;
  updatedAt: string;
}

export class OracleStore {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly databasePath: string;
  readonly backupsDir: string;
  readonly objects: ContentAddressedStore;
  readonly projector: SessionProjector;
  readonly database: DatabaseSync;
  readonly now: () => Date;
  readonly idGenerator: () => string;
  readonly backupRetention: number;

  constructor(options: OracleStoreOptions) {
    this.rootDir = options.rootDir;
    this.sessionsDir = options.sessionsDir;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => `job_${randomUUID()}`);
    this.backupRetention = options.backupRetention ?? 7;
    ensurePrivateDirectory(this.rootDir);
    ensurePrivateDirectory(this.sessionsDir);
    this.backupsDir = path.join(this.rootDir, "backups");
    ensurePrivateDirectory(this.backupsDir);
    this.objects = new ContentAddressedStore(path.join(this.rootDir, "objects", "sha256"));
    this.databasePath = path.join(this.rootDir, "oracle.db");
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.projector = new SessionProjector(this.sessionsDir, (ref) => this.readObject(ref));
    try {
      runMigrations(this.database, this.nowIso());
      this.hardenDatabaseFiles();
      this.assertDatabaseIntegrity();
      this.assertLedgerIntegrity();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  putObject<T extends ObjectRef["objectClass"]>(
    bytes: Uint8Array,
    options: PutObjectOptions<T>,
  ): TypedObjectRef<T> {
    const ref = this.objects.put(bytes, options);
    const existing = this.database
      .prepare("SELECT sha256, size_bytes, media_type, object_class FROM objects WHERE sha256 = ?")
      .get(ref.sha256) as SqlRow | undefined;
    if (existing) {
      if (
        Number(existing.size_bytes) !== ref.sizeBytes ||
        existing.media_type !== ref.mediaType ||
        existing.object_class !== ref.objectClass
      ) {
        throw new StorageIntegrityError(
          `Object metadata conflict for ${ref.sha256}; existing object identity is authoritative`,
        );
      }
      return ref;
    }
    this.database
      .prepare(
        `INSERT INTO objects(sha256, size_bytes, media_type, object_class, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ref.sha256, ref.sizeBytes, ref.mediaType, ref.objectClass, this.nowIso());
    return ref;
  }

  readObject(ref: ObjectRef): Buffer {
    this.requireRegisteredObject(ref);
    return this.objects.read(ref);
  }

  objectPath(sha256: string): string {
    return this.objects.pathFor(sha256);
  }

  hasObject(sha256: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS present FROM objects WHERE sha256 = ?")
      .get(sha256);
    return row !== undefined && this.objects.has(sha256);
  }

  admitJob(
    specInput: JobSpec,
    options: { jobId?: string; blockedBy?: "capacity" | "auth" | "provider" | "owner" } = {},
  ): AdmissionResult {
    const spec = parseJobSpec(specInput);
    const specBytes = serializeJson(spec);
    const specSha256 = digest(specBytes);
    const existing = this.database
      .prepare(
        "SELECT id, spec_object_sha256 FROM jobs WHERE idempotency_scope = ? AND idempotency_key = ?",
      )
      .get(spec.idempotency.scope, spec.idempotency.key) as SqlRow | undefined;
    if (existing) {
      const job = this.getJob(String(existing.id));
      return {
        created: false,
        specMatches: String(existing.spec_object_sha256) === specSha256,
        job,
      };
    }

    this.requireRegisteredObject(spec.input.prompt);
    if (spec.input.bundle) this.requireRegisteredObject(spec.input.bundle);
    const specRef = this.putObject(specBytes, {
      mediaType: "application/json",
      objectClass: "job-spec",
      expectedSha256: specSha256,
    });
    const jobId = requireJobId(options.jobId ?? this.idGenerator());
    const state = initialJobState(options.blockedBy);
    const now = this.nowIso();

    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO jobs(
             id, schema_version, idempotency_scope, idempotency_key,
             spec_object_sha256, state_kind, state_json, state_version,
             projection_pending, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(
          jobId,
          spec.schemaVersion,
          spec.idempotency.scope,
          spec.idempotency.key,
          specRef.sha256,
          state.kind,
          JSON.stringify(state),
          now,
          now,
        );
      const admission = {
        schemaVersion: "oracle.job-authority.v2",
        type: "job-admitted",
        jobId,
        specObjectSha256: specRef.sha256,
        ...(options.blockedBy ? { blockedBy: options.blockedBy } : {}),
      };
      this.database
        .prepare(
          "INSERT INTO job_events(job_id, seq, event_type, event_json, created_at) VALUES (?, 1, ?, ?, ?)",
        )
        .run(jobId, "job-admitted", JSON.stringify(admission), now);
      this.insertJobObject(jobId, "job-spec", specRef, "authority");
      this.insertJobObject(jobId, "prompt", spec.input.prompt, "authority");
      if (spec.input.bundle) this.insertJobObject(jobId, "bundle", spec.input.bundle, "authority");
    });
    this.tryProjection(jobId);
    return { created: true, specMatches: true, job: this.getJob(jobId) };
  }

  setProviderStatus(
    provider: "chatgpt-web",
    receiptInput: CompatibilityReceipt,
  ): ProviderStatusRecord {
    const receipt = compatibilityReceiptSchema.parse(receiptInput);
    const state = receipt.compatible ? "compatible" : "incompatible";
    const updatedAt = this.nowIso();
    this.database
      .prepare(
        `INSERT INTO provider_status(provider, state, adapter_version, ui_fingerprint, receipt_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           state = excluded.state,
           adapter_version = excluded.adapter_version,
           ui_fingerprint = excluded.ui_fingerprint,
           receipt_json = excluded.receipt_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        provider,
        state,
        receipt.adapterVersion,
        receipt.uiFingerprint,
        JSON.stringify(receipt),
        updatedAt,
      );
    return { provider, state, receipt, updatedAt };
  }

  getProviderStatus(provider: "chatgpt-web"): ProviderStatusRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT provider, state, receipt_json, updated_at FROM provider_status WHERE provider = ?",
      )
      .get(provider) as SqlRow | undefined;
    if (!row) return undefined;
    const state = String(row.state);
    if (state !== "compatible" && state !== "incompatible") {
      throw new StorageIntegrityError(`Invalid provider state for ${provider}: ${state}`);
    }
    return {
      provider,
      state,
      receipt: compatibilityReceiptSchema.parse(JSON.parse(String(row.receipt_json))),
      updatedAt: String(row.updated_at),
    };
  }

  getJob(jobId: string): StoredJob {
    const row = this.requireJobRow(jobId);
    const specRef = this.objectRefFromRow(String(row.spec_object_sha256));
    const spec = parseJobSpec(JSON.parse(this.readObject(specRef).toString("utf8")));
    if (
      row.schema_version !== spec.schemaVersion ||
      row.idempotency_scope !== spec.idempotency.scope ||
      row.idempotency_key !== spec.idempotency.key
    ) {
      throw new StorageIntegrityError(`Job ${jobId} columns do not match its JobSpec object`);
    }
    const state = validateJobState(
      { jobId, spec },
      parseJobState(JSON.parse(String(row.state_json))),
    );
    return {
      id: jobId,
      spec,
      specObjectSha256: String(row.spec_object_sha256),
      state,
      stateVersion: Number(row.state_version),
      projectionPending: Number(row.projection_pending) === 1,
      ...(row.projection_error ? { projectionError: String(row.projection_error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listJobs(): StoredJob[] {
    const rows = this.database
      .prepare("SELECT id FROM jobs ORDER BY created_at, id")
      .all() as SqlRow[];
    return rows.map((row) => this.getJob(String(row.id)));
  }

  listEvents(jobId: string): StoredEvent[] {
    this.requireJobRow(jobId);
    const rows = this.database
      .prepare(
        "SELECT seq, event_type, event_json, created_at FROM job_events WHERE job_id = ? ORDER BY seq",
      )
      .all(jobId) as SqlRow[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      type: String(row.event_type),
      event: JSON.parse(String(row.event_json)),
      createdAt: String(row.created_at),
    }));
  }

  appendEvent(
    jobId: string,
    expectedVersion: number,
    event: JobEvent,
    options: AppendEventOptions = {},
  ): StoredJob {
    const safeJobId = requireJobId(jobId);
    this.transaction(() => {
      const current = this.getJob(safeJobId);
      if (current.stateVersion !== expectedVersion) {
        throw new StateVersionConflictError(safeJobId, expectedVersion, current.stateVersion);
      }
      const next = reduceJob({ jobId: safeJobId, spec: current.spec }, current.state, event);
      this.ensureEventObjects(event);
      const seqRow = this.database
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM job_events WHERE job_id = ?")
        .get(safeJobId) as SqlRow;
      const nextSeq = Number(seqRow.next_seq);
      const now = this.nowIso();
      this.database
        .prepare(
          "INSERT INTO job_events(job_id, seq, event_type, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(safeJobId, nextSeq, event.type, JSON.stringify(event), now);
      injectFault(options.faultAt, "after-event-insert");

      const result = this.database
        .prepare(
          `UPDATE jobs
           SET state_kind = ?, state_json = ?, state_version = state_version + 1,
               projection_pending = 1, projection_error = NULL, updated_at = ?
           WHERE id = ? AND state_version = ?`,
        )
        .run(next.kind, JSON.stringify(next), now, safeJobId, expectedVersion);
      if (Number(result.changes) !== 1) {
        const actual = Number(this.requireJobRow(safeJobId).state_version);
        throw new StateVersionConflictError(safeJobId, expectedVersion, actual);
      }
      this.linkEventObjects(safeJobId, nextSeq, event);
      injectFault(options.faultAt, "after-state-update");
    });
    this.tryProjection(safeJobId);
    return this.getJob(safeJobId);
  }

  linkJobObject(
    jobId: string,
    role: string,
    ref: ObjectRef,
    retentionClass: "authority" | "debug",
    pinnedUntil?: string,
  ): void {
    this.requireJobRow(jobId);
    this.requireRegisteredObject(ref);
    this.insertJobObject(jobId, role, ref, retentionClass, pinnedUntil);
  }

  projectionPath(jobId: string): string {
    return this.projector.pathFor(jobId);
  }

  rebuildProjections(): number {
    const jobs = this.listJobs();
    let rebuilt = 0;
    for (const job of jobs) {
      this.projectJob(job);
      rebuilt += 1;
    }
    return rebuilt;
  }

  verifyStorage(): StorageVerification {
    const database = this.quickCheck();
    const rows = this.database
      .prepare("SELECT sha256, size_bytes, media_type, object_class FROM objects ORDER BY sha256")
      .all() as SqlRow[];
    const objectErrors: { sha256: string; message: string }[] = [];
    for (const row of rows) {
      const ref = rowToObjectRef(row);
      try {
        this.objects.read(ref);
      } catch (error) {
        objectErrors.push({
          sha256: ref.sha256,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ledgerErrors = this.verifyLedger();
    return { database, checkedObjects: rows.length, objectErrors, ledgerErrors };
  }

  async createBackup(): Promise<string> {
    this.assertDatabaseIntegrity();
    this.assertLedgerIntegrity();
    ensurePrivateDirectory(this.backupsDir);
    const stamp = this.nowIso().replaceAll(/[:.]/gu, "-");
    const destination = path.join(
      this.backupsDir,
      `oracle-${stamp}-${randomUUID().slice(0, 8)}.sqlite`,
    );
    await backup(this.database, destination);
    chmodSync(destination, 0o600);
    const backups = this.listBackups();
    for (const stale of backups.slice(this.backupRetention)) unlinkSync(stale);
    return destination;
  }

  listBackups(): string[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .filter((name) => name.endsWith(".sqlite"))
      .sort((left, right) => right.localeCompare(left))
      .map((name) => path.join(this.backupsDir, name));
  }

  pruneDebugObjects(options: DebugPruneOptions): DebugPruneResult {
    if (options.ttlMs < 0 || options.maxBytes < 0 || options.keepLatest < 0) {
      throw new Error("Debug retention values must be non-negative");
    }
    const rows = this.database
      .prepare(
        `SELECT o.sha256, o.size_bytes, o.media_type, o.object_class, o.created_at,
                jo.pinned_until, j.state_kind
         FROM objects o
         LEFT JOIN job_objects jo ON jo.sha256 = o.sha256
         LEFT JOIN jobs j ON j.id = jo.job_id
         WHERE o.object_class = 'debug'
         ORDER BY o.created_at DESC, o.sha256`,
      )
      .all() as SqlRow[];
    const grouped = groupDebugRows(rows, this.now().getTime());
    const latest = new Set(grouped.slice(0, options.keepLatest).map((item) => item.sha256));
    const cutoff = this.now().getTime() - options.ttlMs;
    const deleted = new Set<string>();
    let pinned = 0;

    for (const item of grouped) {
      if (item.pinned) {
        pinned += 1;
        continue;
      }
      if (!latest.has(item.sha256) && Date.parse(item.createdAt) < cutoff) deleted.add(item.sha256);
    }

    let retainedBytes = grouped
      .filter((item) => !deleted.has(item.sha256))
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    for (let index = grouped.length - 1; index >= 0; index -= 1) {
      const item = grouped[index]!;
      if (retainedBytes <= options.maxBytes) break;
      if (item.pinned || latest.has(item.sha256) || deleted.has(item.sha256)) continue;
      deleted.add(item.sha256);
      retainedBytes -= item.sizeBytes;
    }

    this.transaction(() => {
      const statement = this.database.prepare("DELETE FROM objects WHERE sha256 = ?");
      for (const sha256 of deleted) statement.run(sha256);
    });
    for (const sha256 of deleted) this.objects.delete(sha256);
    return { deleted: deleted.size, pinned, retainedBytes };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private requireJobRow(jobId: string): SqlRow {
    const safeJobId = requireJobId(jobId);
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(safeJobId) as
      | SqlRow
      | undefined;
    if (!row) throw new Error(`Unknown Oracle v2 job: ${safeJobId}`);
    return row;
  }

  private objectRefFromRow(sha256: string): ObjectRef {
    const row = this.database
      .prepare("SELECT sha256, size_bytes, media_type, object_class FROM objects WHERE sha256 = ?")
      .get(sha256) as SqlRow | undefined;
    if (!row) throw new StorageIntegrityError(`Object ${sha256} is not registered`);
    return rowToObjectRef(row);
  }

  private requireRegisteredObject(ref: ObjectRef): void {
    const registered = this.objectRefFromRow(ref.sha256);
    if (
      registered.sizeBytes !== ref.sizeBytes ||
      registered.mediaType !== ref.mediaType ||
      registered.objectClass !== ref.objectClass
    ) {
      throw new StorageIntegrityError(
        `Registered metadata does not match object ref ${ref.sha256}`,
      );
    }
    this.objects.read(ref);
  }

  private insertJobObject(
    jobId: string,
    role: string,
    ref: ObjectRef,
    retentionClass: "authority" | "debug",
    pinnedUntil?: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO job_objects(job_id, role, sha256, retention_class, pinned_until)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id, role, sha256) DO UPDATE SET
           retention_class = excluded.retention_class,
           pinned_until = excluded.pinned_until`,
      )
      .run(jobId, role, ref.sha256, retentionClass, pinnedUntil ?? null);
  }

  private ensureEventObjects(event: JobEvent): void {
    if (event.type === "capture-completed") this.requireRegisteredObject(event.answer);
    if ("failure" in event && event.failure.diagnosticObject) {
      this.requireRegisteredObject(event.failure.diagnosticObject);
    }
  }

  private linkEventObjects(jobId: string, seq: number, event: JobEvent): void {
    if (event.type === "capture-completed") {
      this.insertJobObject(jobId, "answer", event.answer, "authority");
    }
    if ("failure" in event && event.failure.diagnosticObject) {
      this.insertJobObject(jobId, `debug:${seq}`, event.failure.diagnosticObject, "debug");
    }
  }

  private tryProjection(jobId: string): void {
    try {
      this.projectJob(this.getJob(jobId));
    } catch (error) {
      this.database
        .prepare("UPDATE jobs SET projection_pending = 1, projection_error = ? WHERE id = ?")
        .run(error instanceof Error ? error.message : String(error), jobId);
    }
  }

  private projectJob(job: StoredJob): void {
    this.projector.write(job, this.listEvents(job.id));
    this.database
      .prepare("UPDATE jobs SET projection_pending = 0, projection_error = NULL WHERE id = ?")
      .run(job.id);
  }

  private quickCheck(): "ok" | string {
    const row = this.database.prepare("PRAGMA quick_check").get() as SqlRow;
    const value = String(row.quick_check ?? Object.values(row)[0]);
    return value === "ok" ? "ok" : value;
  }

  private assertDatabaseIntegrity(): void {
    const result = this.quickCheck();
    if (result !== "ok") throw new StorageIntegrityError(`SQLite quick_check failed: ${result}`);
  }

  private verifyLedger(): { jobId: string; message: string }[] {
    const rows = this.database
      .prepare(
        "SELECT id, state_json, state_kind, state_version, spec_object_sha256 FROM jobs ORDER BY id",
      )
      .all() as SqlRow[];
    const errors: { jobId: string; message: string }[] = [];
    for (const row of rows) {
      const jobId = String(row.id);
      try {
        const specRef = this.objectRefFromRow(String(row.spec_object_sha256));
        const spec = parseJobSpec(JSON.parse(this.readObject(specRef).toString("utf8")));
        const events = this.listEvents(jobId);
        const admission = events[0];
        if (
          !admission ||
          admission.seq !== 1 ||
          admission.type !== "job-admitted" ||
          !isAdmissionEvent(admission.event, jobId, specRef.sha256)
        ) {
          throw new Error("missing or invalid seq=1 job-admitted authority event");
        }
        let replayed = initialJobState(admissionBlockedBy(admission.event));
        let expectedSeq = 2;
        for (const item of events.slice(1)) {
          if (item.seq !== expectedSeq) {
            throw new Error(`event sequence gap: expected ${expectedSeq}, received ${item.seq}`);
          }
          replayed = reduceJob({ jobId, spec }, replayed, parseJobEvent(item.event));
          expectedSeq += 1;
        }
        const expectedVersion = events.length - 1;
        const storedState = validateJobState(
          { jobId, spec },
          parseJobState(JSON.parse(String(row.state_json))),
        );
        if (
          Number(row.state_version) !== expectedVersion ||
          row.state_kind !== storedState.kind ||
          JSON.stringify(storedState) !== JSON.stringify(replayed)
        ) {
          throw new Error(
            `snapshot/event mismatch at version ${String(row.state_version)}; replayed ${expectedVersion}`,
          );
        }
      } catch (error) {
        errors.push({ jobId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return errors;
  }

  private assertLedgerIntegrity(): void {
    const errors = this.verifyLedger();
    if (errors.length > 0) {
      throw new StorageIntegrityError(
        `Oracle ledger verification failed: ${errors.map((item) => `${item.jobId}: ${item.message}`).join("; ")}`,
      );
    }
  }

  private hardenDatabaseFiles(): void {
    for (const candidate of [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireJobId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Invalid Oracle v2 job id: ${value}`);
  }
  return value;
}

function rowToObjectRef(row: SqlRow): ObjectRef {
  return objectRefSchema.parse({
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mediaType: String(row.media_type),
    objectClass: String(row.object_class),
  });
}

function injectFault(configured: StoreFaultPoint | undefined, point: StoreFaultPoint): void {
  if (configured === point) throw new StoreFaultError(point);
}

type DebugObject = {
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  pinned: boolean;
};

function groupDebugRows(rows: SqlRow[], nowMs: number): DebugObject[] {
  const grouped = new Map<string, DebugObject>();
  for (const row of rows) {
    const sha256 = String(row.sha256);
    const item = grouped.get(sha256) ?? {
      sha256,
      sizeBytes: Number(row.size_bytes),
      createdAt: String(row.created_at),
      pinned: false,
    };
    const pinTime = row.pinned_until ? Date.parse(String(row.pinned_until)) : Number.NaN;
    const state = row.state_kind ? String(row.state_kind) : undefined;
    if ((Number.isFinite(pinTime) && pinTime >= nowMs) || (state && !isTerminalState(state))) {
      item.pinned = true;
    }
    grouped.set(sha256, item);
  }
  return [...grouped.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.sha256.localeCompare(right.sha256),
  );
}

function isTerminalState(state: string): boolean {
  return ["completed", "failed-unsent", "canceled-unsent", "abandoned"].includes(state);
}

function isAdmissionEvent(event: unknown, jobId: string, specObjectSha256: string): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const candidate = event as Record<string, unknown>;
  return (
    candidate.schemaVersion === "oracle.job-authority.v2" &&
    candidate.type === "job-admitted" &&
    candidate.jobId === jobId &&
    candidate.specObjectSha256 === specObjectSha256 &&
    (candidate.blockedBy === undefined ||
      ["capacity", "auth", "provider", "owner"].includes(String(candidate.blockedBy)))
  );
}

function admissionBlockedBy(
  event: unknown,
): "capacity" | "auth" | "provider" | "owner" | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const blockedBy = (event as Record<string, unknown>).blockedBy;
  return blockedBy === "capacity" ||
    blockedBy === "auth" ||
    blockedBy === "provider" ||
    blockedBy === "owner"
    ? blockedBy
    : undefined;
}
