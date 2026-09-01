import type { DatabaseSync } from "node:sqlite";

export const STORE_SCHEMA_VERSION = 1;

const migrationOne = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  spec_object_sha256 TEXT NOT NULL,
  state_kind TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  projection_pending INTEGER NOT NULL DEFAULT 1,
  projection_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(idempotency_scope, idempotency_key),
  FOREIGN KEY(spec_object_sha256) REFERENCES objects(sha256)
);

CREATE TABLE job_events (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, seq),
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE objects (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  object_class TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE job_objects (
  job_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  pinned_until TEXT,
  PRIMARY KEY(job_id, role, sha256),
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(sha256) REFERENCES objects(sha256) ON DELETE CASCADE
);

CREATE TABLE provider_status (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  ui_fingerprint TEXT,
  receipt_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX job_events_by_job ON job_events(job_id, seq);
CREATE INDEX job_objects_by_sha ON job_objects(sha256);
CREATE INDEX objects_by_class_created ON objects(object_class, created_at);
`;

export function runMigrations(database: DatabaseSync, appliedAt: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const rows = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
    version: number;
  }[];
  const current = rows.at(-1)?.version ?? 0;
  if (current > STORE_SCHEMA_VERSION) {
    throw new Error(
      `Oracle store schema ${current} is newer than supported ${STORE_SCHEMA_VERSION}`,
    );
  }
  if (current === STORE_SCHEMA_VERSION) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    if (current < 1) {
      database.exec(migrationOne);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, appliedAt);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
