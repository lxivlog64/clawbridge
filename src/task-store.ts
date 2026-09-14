import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ExecutionState = "queued" | "preparing" | "dispatching" | "running" | "waiting_input" | "waiting_permission" | "stalled" | "succeeded" | "failed" | "cancel_requested" | "cancelled" | "unknown";
export type DeliveryState = "not_started" | "validating" | "pushing" | "creating_pr" | "ready" | "failed";
export type ReviewState = "not_requested" | "pending" | "changes_requested" | "reviewed";

export interface TaskRecord {
  taskId: string;
  idempotencyKey: string;
  projectId: string;
  specHash: string;
  requestedModel?: string;
  createdAt: string;
  updatedAt: string;
  executionState: ExecutionState;
  deliveryState: DeliveryState;
  reviewState: ReviewState;
}

interface TaskRow {
  task_id: string;
  idempotency_key: string;
  project_id: string;
  spec_hash: string;
  requested_model: string | null;
  created_at: string;
  updated_at: string;
  execution_state: ExecutionState;
  delivery_state: DeliveryState;
  review_state: ReviewState;
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(databaseFile: string) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databaseFile), 0o700);
    this.db = new Database(databaseFile);
    fs.chmodSync(databaseFile, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        spec TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        requested_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        execution_state TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        review_state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_created ON tasks(project_id, created_at DESC);
    `);
    this.ensureColumn("spec", "TEXT");
  }

  createOrGet(input: { projectId: string; spec: string; idempotencyKey: string; requestedModel?: string }): { task: TaskRecord; reused: boolean } {
    const specHash = digest(input.spec);
    const existing = this.db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(input.idempotencyKey) as TaskRow | undefined;
    if (existing) {
      if (existing.project_id !== input.projectId || existing.spec_hash !== specHash || existing.requested_model !== (input.requestedModel ?? null)) {
        throw new Error("Idempotency key was already used with different task input.");
      }
      return { task: taskFromRow(existing), reused: true };
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: crypto.randomUUID(), idempotencyKey: input.idempotencyKey, projectId: input.projectId,
      specHash, requestedModel: input.requestedModel, createdAt: now, updatedAt: now,
      executionState: "queued", deliveryState: "not_started", reviewState: "not_requested",
    };
    this.db.prepare(`INSERT INTO tasks (
      task_id, idempotency_key, project_id, spec, spec_hash, requested_model, created_at, updated_at,
      execution_state, delivery_state, review_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.taskId, task.idempotencyKey, task.projectId, input.spec, task.specHash, task.requestedModel ?? null,
        task.createdAt, task.updatedAt, task.executionState, task.deliveryState, task.reviewState);
    return { task, reused: false };
  }

  get(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getSpec(taskId: string): string | undefined {
    const row = this.db.prepare("SELECT spec FROM tasks WHERE task_id = ?").get(taskId) as { spec?: string } | undefined;
    return row?.spec;
  }

  list(filters: { projectId?: string; executionState?: ExecutionState; limit: number }): TaskRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.projectId) { conditions.push("project_id = ?"); values.push(filters.projectId); }
    if (filters.executionState) { conditions.push("execution_state = ?"); values.push(filters.executionState); }
    values.push(filters.limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...values) as TaskRow[];
    return rows.map(taskFromRow);
  }

  close(): void { this.db.close(); }

  private ensureColumn(column: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  }
}

function digest(value: string): string { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id, idempotencyKey: row.idempotency_key, projectId: row.project_id,
    specHash: row.spec_hash, requestedModel: row.requested_model ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at, executionState: row.execution_state,
    deliveryState: row.delivery_state, reviewState: row.review_state,
  };
}
