import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type CloudTaskState = "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface CloudTask {
  taskId: string;
  idempotencyKey: string;
  projectId: string;
  workerId: string;
  spec: string;
  specHash: string;
  requestedModel?: string;
  state: CloudTaskState;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  result?: Record<string, unknown>;
}

export interface CloudWorker {
  workerId: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

interface TaskRow {
  task_id: string; idempotency_key: string; project_id: string; worker_id: string;
  spec: string; spec_hash: string; requested_model: string | null; state: CloudTaskState;
  created_at: string; updated_at: string; lease_owner: string | null; lease_expires_at: string | null;
  result_json: string | null;
}

interface WorkerRow { worker_id: string; last_seen_at: string; metadata_json: string | null }

/** Durable task queue for the public control plane. It deliberately stores no worker credentials. */
export class CloudTaskStore {
  private readonly db: Database.Database;

  constructor(databaseFile: string) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databaseFile), 0o700);
    this.db = new Database(databaseFile);
    fs.chmodSync(databaseFile, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_tasks (
        task_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, worker_id TEXT NOT NULL, spec TEXT NOT NULL,
        spec_hash TEXT NOT NULL, requested_model TEXT, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        lease_owner TEXT, lease_expires_at TEXT, result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS cloud_tasks_claim ON cloud_tasks(worker_id, state, created_at);
      CREATE TABLE IF NOT EXISTS cloud_workers (
        worker_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL, metadata_json TEXT
      );
    `);
  }

  createOrGet(input: { projectId: string; workerId: string; spec: string; idempotencyKey: string; requestedModel?: string }): { task: CloudTask; reused: boolean } {
    const existing = this.db.prepare("SELECT * FROM cloud_tasks WHERE idempotency_key = ?").get(input.idempotencyKey) as TaskRow | undefined;
    const specHash = digest(input.spec);
    if (existing) {
      if (existing.project_id !== input.projectId || existing.worker_id !== input.workerId || existing.spec_hash !== specHash || existing.requested_model !== (input.requestedModel ?? null)) {
        throw new Error("Idempotency key was already used with different task input.");
      }
      return { task: taskFromRow(existing), reused: true };
    }
    const now = new Date().toISOString();
    const task: CloudTask = {
      taskId: crypto.randomUUID(), idempotencyKey: input.idempotencyKey, projectId: input.projectId,
      workerId: input.workerId, spec: input.spec, specHash, ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      state: "queued", createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO cloud_tasks (
      task_id, idempotency_key, project_id, worker_id, spec, spec_hash, requested_model, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.taskId, task.idempotencyKey, task.projectId, task.workerId, task.spec, task.specHash,
        task.requestedModel ?? null, task.state, task.createdAt, task.updatedAt);
    return { task, reused: false };
  }

  get(taskId: string): CloudTask | undefined {
    const row = this.db.prepare("SELECT * FROM cloud_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  heartbeat(workerId: string, metadata?: Record<string, unknown>): CloudWorker {
    const lastSeenAt = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.db.prepare(`INSERT INTO cloud_workers (worker_id, last_seen_at, metadata_json) VALUES (?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, metadata_json = excluded.metadata_json`)
      .run(workerId, lastSeenAt, metadataJson);
    return { workerId, lastSeenAt, ...(metadata ? { metadata } : {}) };
  }

  claim(workerId: string, leaseMs: number): CloudTask | undefined {
    const transaction = this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const candidate = this.db.prepare(`SELECT * FROM cloud_tasks
        WHERE worker_id = ? AND (state = 'queued' OR (state IN ('leased', 'running') AND lease_expires_at < ?))
        ORDER BY created_at ASC LIMIT 1`).get(workerId, nowIso) as TaskRow | undefined;
      if (!candidate) return undefined;
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const updated = this.db.prepare(`UPDATE cloud_tasks SET state = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE task_id = ? AND (state = 'queued' OR (state IN ('leased', 'running') AND lease_expires_at < ?))`)
        .run(workerId, leaseExpiresAt, nowIso, candidate.task_id, nowIso);
      if (updated.changes !== 1) return undefined;
      return this.get(candidate.task_id);
    });
    return transaction();
  }

  updateFromWorker(taskId: string, workerId: string, state: Exclude<CloudTaskState, "queued" | "leased">, result?: Record<string, unknown>, leaseMs = 90_000): CloudTask {
    const current = this.get(taskId);
    if (!current) throw new Error("Unknown cloud task.");
    if (current.workerId !== workerId || current.leaseOwner !== workerId) throw new Error("Worker does not own this task lease.");
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) < Date.now()) throw new Error("Task lease has expired.");
    const now = new Date();
    const terminal = state === "succeeded" || state === "failed" || state === "cancelled";
    const leaseExpiresAt = terminal ? null : new Date(now.getTime() + leaseMs).toISOString();
    this.db.prepare(`UPDATE cloud_tasks SET state = ?, result_json = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?`)
      .run(state, result ? JSON.stringify(result) : null, leaseExpiresAt, now.toISOString(), taskId);
    return this.get(taskId)!;
  }

  close(): void { this.db.close(); }
}

function taskFromRow(row: TaskRow): CloudTask {
  return {
    taskId: row.task_id, idempotencyKey: row.idempotency_key, projectId: row.project_id, workerId: row.worker_id,
    spec: row.spec, specHash: row.spec_hash, ...(row.requested_model ? { requestedModel: row.requested_model } : {}),
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
  };
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
