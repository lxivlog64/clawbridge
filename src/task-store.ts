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
  remoteJobId?: string;
  blockReason?: string;
  lastEventAt?: string;
  worktreePath?: string;
  headSha?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  executionState: ExecutionState;
  deliveryState: DeliveryState;
  reviewState: ReviewState;
}

export interface TaskEvent {
  eventId: string;
  taskId: string;
  kind: string;
  summary: string;
  createdAt: string;
  deliveredAt?: string;
}

interface TaskRow {
  task_id: string;
  idempotency_key: string;
  project_id: string;
  spec_hash: string;
  requested_model: string | null;
  remote_job_id: string | null;
  block_reason: string | null;
  last_event_at: string | null;
  worktree_path: string | null;
  head_sha: string | null;
  pr_url: string | null;
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
        remote_job_id TEXT UNIQUE,
        block_reason TEXT,
        last_event_at TEXT,
        worktree_path TEXT,
        head_sha TEXT,
        pr_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        execution_state TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        review_state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_created ON tasks(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS task_events_pending ON task_events(delivered_at, created_at ASC);
    `);
    this.ensureColumn("spec", "TEXT");
    this.ensureColumn("remote_job_id", "TEXT");
    this.ensureColumn("block_reason", "TEXT");
    this.ensureColumn("last_event_at", "TEXT");
    this.ensureColumn("worktree_path", "TEXT");
    this.ensureColumn("head_sha", "TEXT");
    this.ensureColumn("pr_url", "TEXT");
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
      specHash, ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}), createdAt: now, updatedAt: now,
      executionState: "queued", deliveryState: "not_started", reviewState: "not_requested",
    };
    this.db.prepare(`INSERT INTO tasks (
      task_id, idempotency_key, project_id, spec, spec_hash, requested_model, created_at, updated_at,
      execution_state, delivery_state, review_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.taskId, task.idempotencyKey, task.projectId, input.spec, task.specHash, task.requestedModel ?? null,
        task.createdAt, task.updatedAt, task.executionState, task.deliveryState, task.reviewState);
    this.emit(task.taskId, "task.queued", "Task was queued.");
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

  listEvents(limit: number, pendingOnly = false): TaskEvent[] {
    const where = pendingOnly ? "WHERE delivered_at IS NULL" : "";
    const rows = this.db.prepare(`SELECT * FROM task_events ${where} ORDER BY created_at ASC LIMIT ?`).all(limit) as Array<{ event_id: string; task_id: string; kind: string; summary: string; created_at: string; delivered_at: string | null }>;
    return rows.map((row) => ({ eventId: row.event_id, taskId: row.task_id, kind: row.kind, summary: row.summary, createdAt: row.created_at, ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}) }));
  }

  acknowledgeEvent(eventId: string): boolean {
    return this.db.prepare("UPDATE task_events SET delivered_at = ? WHERE event_id = ? AND delivered_at IS NULL")
      .run(new Date().toISOString(), eventId).changes === 1;
  }

  activeCount(projectId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND execution_state IN (
      'preparing', 'dispatching', 'running', 'waiting_input', 'waiting_permission', 'stalled', 'cancel_requested'
    )`).get(projectId) as { count: number };
    return row.count;
  }

  markDispatched(taskId: string, remoteJobId: string): TaskRecord {
    return this.update(taskId, { executionState: "running", remoteJobId, blockReason: undefined, lastEventAt: new Date().toISOString() });
  }

  markExecution(taskId: string, executionState: ExecutionState, blockReason?: string): TaskRecord {
    return this.update(taskId, { executionState, blockReason, lastEventAt: new Date().toISOString() });
  }

  markVerified(taskId: string, worktreePath: string, headSha: string): TaskRecord {
    return this.update(taskId, { deliveryState: "validating", worktreePath, headSha });
  }

  markDelivery(taskId: string, deliveryState: DeliveryState, patch: { prUrl?: string; blockReason?: string } = {}): TaskRecord {
    return this.update(taskId, { deliveryState, prUrl: patch.prUrl, blockReason: patch.blockReason });
  }

  close(): void { this.db.close(); }

  private ensureColumn(column: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  }

  private update(taskId: string, patch: { executionState?: ExecutionState; deliveryState?: DeliveryState; remoteJobId?: string; blockReason?: string; lastEventAt?: string; worktreePath?: string; headSha?: string; prUrl?: string }): TaskRecord {
    const existing = this.get(taskId);
    if (!existing) throw new Error(`Unknown task id ${taskId}.`);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE tasks SET execution_state = ?, delivery_state = ?, remote_job_id = ?, block_reason = ?, last_event_at = ?, worktree_path = ?, head_sha = ?, pr_url = ?, updated_at = ? WHERE task_id = ?`)
      .run(patch.executionState ?? existing.executionState, patch.deliveryState ?? existing.deliveryState,
        patch.remoteJobId ?? existing.remoteJobId ?? null, patch.blockReason ?? null,
        patch.lastEventAt ?? existing.lastEventAt ?? null, patch.worktreePath ?? existing.worktreePath ?? null,
        patch.headSha ?? existing.headSha ?? null, patch.prUrl ?? existing.prUrl ?? null, now, taskId);
    const updated = this.get(taskId)!;
    if (updated.executionState !== existing.executionState || updated.deliveryState !== existing.deliveryState || updated.blockReason !== existing.blockReason) {
      this.emit(taskId, "task.state_changed", `${existing.executionState}/${existing.deliveryState} → ${updated.executionState}/${updated.deliveryState}${updated.blockReason ? `: ${updated.blockReason.slice(0, 500)}` : ""}`);
    }
    return updated;
  }

  private emit(taskId: string, kind: string, summary: string): void {
    this.db.prepare("INSERT INTO task_events (event_id, task_id, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, kind, summary, new Date().toISOString());
  }
}

function digest(value: string): string { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id, idempotencyKey: row.idempotency_key, projectId: row.project_id,
    specHash: row.spec_hash,
    ...(row.requested_model ? { requestedModel: row.requested_model } : {}),
    ...(row.remote_job_id ? { remoteJobId: row.remote_job_id } : {}),
    ...(row.block_reason ? { blockReason: row.block_reason } : {}),
    ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {}),
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    ...(row.head_sha ? { headSha: row.head_sha } : {}),
    ...(row.pr_url ? { prUrl: row.pr_url } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at, executionState: row.execution_state,
    deliveryState: row.delivery_state, reviewState: row.review_state,
  };
}
