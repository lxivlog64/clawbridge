import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { NotificationEvent, NotificationOutbox } from "./notifier.js";

export type CloudTaskState = "queued" | "leased" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "unknown";

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
  review?: CloudReview;
}
export interface CloudReview { conclusion: "approved" | "changes_requested"; comment?: string; reviewedHeadSha: string; reviewedAt: string; status: "current" | "stale"; observedHeadSha?: string; }

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
export class CloudTaskStore implements NotificationOutbox {
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
      CREATE TABLE IF NOT EXISTS cloud_task_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT
      );
      CREATE INDEX IF NOT EXISTS cloud_task_events_delivery ON cloud_task_events(delivered_at, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS cloud_task_reviews (
        task_id TEXT PRIMARY KEY, conclusion TEXT NOT NULL, comment TEXT, reviewed_head_sha TEXT NOT NULL,
        reviewed_at TEXT NOT NULL, stale_at TEXT, observed_head_sha TEXT
      );
    `);
  }

  createOrGet(input: { projectId: string; workerId: string; spec: string; idempotencyKey: string; requestedModel?: string }): { task: CloudTask; reused: boolean } {
    return this.db.transaction(() => {
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
    this.emit(task, "task.queued", "任务已进入队列");
      return { task, reused: false };
    })();
  }

  get(taskId: string): CloudTask | undefined {
    const row = this.db.prepare("SELECT * FROM cloud_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? this.withReview(taskFromRow(row)) : undefined;
  }

  list(input: { projectId?: string; state?: CloudTaskState; limit?: number } = {}): CloudTask[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.projectId) { clauses.push("project_id = ?"); values.push(input.projectId); }
    if (input.state) { clauses.push("state = ?"); values.push(input.state); }
    values.push(input.limit ?? 50);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM cloud_tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...values) as TaskRow[];
    return rows.map((row) => this.withReview(taskFromRow(row)));
  }

  requestCancellation(taskId: string): CloudTask {
    return this.db.transaction(() => {
    const current = this.require(taskId);
    if (isTerminal(current.state)) return current;
    const now = new Date().toISOString();
    if (current.state === "queued") {
      this.db.prepare("UPDATE cloud_tasks SET state = 'cancelled', updated_at = ? WHERE task_id = ?").run(now, taskId);
    } else if (current.state === "leased" || current.state === "running" || current.state === "cancel_requested") {
      this.db.prepare("UPDATE cloud_tasks SET state = 'cancel_requested', updated_at = ? WHERE task_id = ?").run(now, taskId);
    } else {
      throw new CloudTaskConflictError("An unknown task must be reconciled before it can be cancelled.");
    }
    const task = this.require(taskId);
    if (task.state !== current.state) this.emit(task, "task.state_changed", `${current.state} → ${task.state}`);
      return task;
    })();
  }

  resolveUnknown(taskId: string, action: "close" | "requeue", remoteJobConfirmedStopped: boolean): CloudTask {
    return this.db.transaction(() => {
    const current = this.require(taskId);
    if (current.state !== "unknown") throw new CloudTaskConflictError("Only an unknown task can be reconciled.");
    if (!remoteJobConfirmedStopped) throw new CloudTaskConflictError("Confirm that the remote CodeBuddy job has stopped before reconciling an unknown task.");
    const now = new Date().toISOString();
    const result = { ...(current.result ?? {}), reconciliation: { action, remoteJobConfirmedStopped: true, resolvedAt: now } };
    if (action === "close") {
      this.db.prepare("UPDATE cloud_tasks SET state = 'cancelled', result_json = ?, updated_at = ? WHERE task_id = ?")
        .run(JSON.stringify(result), now, taskId);
    } else {
      this.db.prepare("UPDATE cloud_tasks SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, result_json = ?, updated_at = ? WHERE task_id = ?")
        .run(JSON.stringify(result), now, taskId);
    }
    const task = this.require(taskId);
    this.emit(task, "task.state_changed", `${current.state} → ${task.state}`);
      return task;
    })();
  }

  heartbeat(workerId: string, metadata?: Record<string, unknown>, leaseMs = 90_000): CloudWorker {
    const lastSeenAt = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.db.prepare(`INSERT INTO cloud_workers (worker_id, last_seen_at, metadata_json) VALUES (?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, metadata_json = excluded.metadata_json`)
      .run(workerId, lastSeenAt, metadataJson);
    // A restarted Worker renews the leases it already owns before attempting
    // recovery.  Only this Worker can do so because the lease owner is part
    // of the predicate.
    this.db.prepare(`UPDATE cloud_tasks SET lease_expires_at = ?, updated_at = ?
      WHERE lease_owner = ? AND state IN ('leased', 'running', 'cancel_requested')`)
      .run(new Date(Date.now() + leaseMs).toISOString(), lastSeenAt, workerId);
    return { workerId, lastSeenAt, ...(metadata ? { metadata } : {}) };
  }

  activeForWorker(workerId: string): CloudTask[] {
    const rows = this.db.prepare(`SELECT * FROM cloud_tasks
      WHERE worker_id = ? AND lease_owner = ? AND state IN ('leased', 'running', 'cancel_requested')
      ORDER BY created_at ASC`).all(workerId, workerId) as TaskRow[];
    return rows.map(taskFromRow);
  }

  claim(workerId: string, leaseMs: number, projectConcurrency: Record<string, number> = {}): CloudTask | undefined {
    const transaction = this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const candidates = this.db.prepare(`SELECT * FROM cloud_tasks
        WHERE worker_id = ? AND state = 'queued'
        ORDER BY created_at ASC LIMIT 100`).all(workerId) as TaskRow[];
      const candidate = candidates.find((item) => {
        const limit = projectConcurrency[item.project_id] ?? 1;
        const active = this.db.prepare(`SELECT COUNT(*) AS count FROM cloud_tasks
          WHERE project_id = ? AND state IN ('leased', 'running', 'cancel_requested')`).get(item.project_id) as { count: number };
        return active.count < limit;
      });
      if (!candidate) return undefined;
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const updated = this.db.prepare(`UPDATE cloud_tasks SET state = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE task_id = ? AND state = 'queued'`)
        .run(workerId, leaseExpiresAt, nowIso, candidate.task_id);
      if (updated.changes !== 1) return undefined;
      return this.get(candidate.task_id);
    });
    return transaction();
  }

  updateFromWorker(taskId: string, workerId: string, state: Exclude<CloudTaskState, "queued" | "leased">, result?: Record<string, unknown>, leaseMs = 90_000): CloudTask {
    return this.db.transaction(() => {
    const current = this.get(taskId);
    if (!current) throw new Error("Unknown cloud task.");
    if (current.workerId !== workerId || current.leaseOwner !== workerId) throw new Error("Worker does not own this task lease.");
    if (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) < Date.now()) throw new Error("Task lease has expired.");
    const now = new Date();
    // A client cancellation wins over a late Worker heartbeat.  The Worker
    // will read this state and stop its remote CodeBuddy job before reporting
    // the terminal cancelled state.
    const nextState = current.state === "cancel_requested" && state === "running" ? "cancel_requested" : state;
    const terminal = isTerminal(nextState);
    const leaseExpiresAt = terminal ? null : new Date(now.getTime() + leaseMs).toISOString();
    this.db.prepare(`UPDATE cloud_tasks SET state = ?, result_json = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?`)
      .run(nextState, result ? JSON.stringify(result) : null, leaseExpiresAt, now.toISOString(), taskId);
    let task = this.get(taskId)!;
    this.invalidateReviewIfHeadChanged(task);
    task = this.get(taskId)!;
    if (task.state !== current.state) this.emit(task, "task.state_changed", `${current.state} → ${task.state}`);
      return task;
    })();
  }

  listDeliverableEvents(limit: number): NotificationEvent[] {
    const now = new Date().toISOString();
    return (this.db.prepare(`SELECT event_id, task_id, kind, summary, created_at FROM cloud_task_events
      WHERE delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC LIMIT ?`).all(now, limit) as Array<{ event_id: string; task_id: string; kind: string; summary: string; created_at: string }>)
      .map((event) => ({ eventId: event.event_id, taskId: event.task_id, kind: event.kind, summary: event.summary, createdAt: event.created_at }));
  }

  acknowledgeEvent(eventId: string): boolean {
    return this.db.prepare("UPDATE cloud_task_events SET delivered_at = ? WHERE event_id = ? AND delivered_at IS NULL")
      .run(new Date().toISOString(), eventId).changes === 1;
  }

  deferEvent(eventId: string): void {
    const row = this.db.prepare("SELECT attempts FROM cloud_task_events WHERE event_id = ? AND delivered_at IS NULL").get(eventId) as { attempts: number } | undefined;
    if (!row) return;
    const delayMs = Math.min(300_000, 5_000 * 2 ** row.attempts);
    this.db.prepare("UPDATE cloud_task_events SET attempts = ?, next_attempt_at = ? WHERE event_id = ?")
      .run(row.attempts + 1, new Date(Date.now() + delayMs).toISOString(), eventId);
  }

  recordReview(taskId: string, input: { conclusion: "approved" | "changes_requested"; comment?: string; reviewedHeadSha: string }): CloudTask {
    return this.db.transaction(() => {
    const task = this.require(taskId);
    const headSha = headShaOf(task);
    if (task.state !== "succeeded" || !headSha) throw new CloudTaskConflictError("Only a delivered task with a verified head SHA can be reviewed.");
    if (headSha !== input.reviewedHeadSha) throw new CloudTaskConflictError("The submitted review SHA is not the task's current delivery SHA.");
    const reviewedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO cloud_task_reviews (task_id, conclusion, comment, reviewed_head_sha, reviewed_at, stale_at, observed_head_sha)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET conclusion=excluded.conclusion, comment=excluded.comment, reviewed_head_sha=excluded.reviewed_head_sha, reviewed_at=excluded.reviewed_at, stale_at=NULL, observed_head_sha=NULL`)
      .run(taskId, input.conclusion, input.comment ?? null, input.reviewedHeadSha, reviewedAt);
    const updated = this.require(taskId);
    this.emit(updated, "task.review_recorded", `审查结论：${input.conclusion}`);
      return updated;
    })();
  }

  observeReviewHead(taskId: string, observedHeadSha: string): CloudTask {
    return this.db.transaction(() => {
    const task = this.require(taskId);
    const review = task.review;
    if (!review || review.reviewedHeadSha === observedHeadSha) return task;
    this.db.prepare("UPDATE cloud_task_reviews SET stale_at = ?, observed_head_sha = ? WHERE task_id = ? AND stale_at IS NULL")
      .run(new Date().toISOString(), observedHeadSha, taskId);
    const updated = this.require(taskId);
    this.emit(updated, "task.review_stale", "PR 有新提交，需重新审查");
      return updated;
    })();
  }

  close(): void { this.db.close(); }

  private require(taskId: string): CloudTask {
    const task = this.get(taskId);
    if (!task) throw new Error("Unknown cloud task.");
    return task;
  }

  private emit(task: CloudTask, kind: string, summary: string): void {
    this.db.prepare("INSERT INTO cloud_task_events (event_id, task_id, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), task.taskId, kind, summary, new Date().toISOString());
  }

  private withReview(task: CloudTask): CloudTask {
    const row = this.db.prepare("SELECT conclusion, comment, reviewed_head_sha, reviewed_at, stale_at, observed_head_sha FROM cloud_task_reviews WHERE task_id = ?").get(task.taskId) as { conclusion: "approved" | "changes_requested"; comment: string | null; reviewed_head_sha: string; reviewed_at: string; stale_at: string | null; observed_head_sha: string | null } | undefined;
    return row ? { ...task, review: { conclusion: row.conclusion, ...(row.comment ? { comment: row.comment } : {}), reviewedHeadSha: row.reviewed_head_sha, reviewedAt: row.reviewed_at, status: row.stale_at ? "stale" : "current", ...(row.observed_head_sha ? { observedHeadSha: row.observed_head_sha } : {}) } } : task;
  }

  private invalidateReviewIfHeadChanged(task: CloudTask): void {
    const head = headShaOf(task);
    if (head) this.observeReviewHead(task.taskId, head);
  }
}

export class CloudTaskConflictError extends Error {}

function isTerminal(state: CloudTaskState): boolean { return state === "succeeded" || state === "failed" || state === "cancelled"; }

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
function headShaOf(task: CloudTask): string | undefined { const value = task.result?.headSha; return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value : undefined; }
