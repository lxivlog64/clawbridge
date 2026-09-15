import type { RegisteredProject, RegisteredWorker } from "./project-registry.js";
import type { RemoteCommandResult } from "./remote-worker.js";

export interface GitPreparerRemote {
  git(worker: RegisteredWorker, cwd: string, args: string[]): Promise<RemoteCommandResult>;
  mkdir(worker: RegisteredWorker, directory: string): Promise<RemoteCommandResult>;
}

export type PrepareResult =
  | { ok: true; worktreePath: string; baseSha: string; branch: string }
  | { ok: false; reason: string };

export async function prepareWorktree(
  taskId: string,
  project: RegisteredProject,
  worker: RegisteredWorker,
  remote: GitPreparerRemote,
  allowsPath: (candidate: string) => boolean,
  requeue?: { priorBaseSha: string },
): Promise<PrepareResult> {
  const repositoryPath = project.remoteRepositoryPath;
  // Keep worktrees beside, rather than inside, the source checkout. Otherwise
  // the worktree container itself appears as an untracked source-tree change.
  const worktreePath = `${repositoryPath}.clawbridge-worktrees/${taskId}`;
  const branch = `clawbridge/${taskId}`;
  if (!allowsPath(worktreePath)) return { ok: false, reason: "Generated worktree path is outside the worker allowlist." };
  const [repository, status] = await Promise.all([
    remote.git(worker, repositoryPath, ["rev-parse", "--is-inside-work-tree"]),
    remote.git(worker, repositoryPath, ["status", "--porcelain"]),
  ]);
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") return { ok: false, reason: "Registered remote repository is not a Git worktree." };
  if (status.exitCode !== 0 || status.stdout.trim()) return { ok: false, reason: "Registered remote repository has uncommitted changes; handoff is required." };
  const fetched = await remote.git(worker, repositoryPath, ["fetch", "--no-tags", project.deliveryRemote, project.defaultBranch]);
  if (fetched.exitCode !== 0) return { ok: false, reason: `Cannot fetch base branch: ${fetched.stderr.slice(-1_000)}` };
  const base = await remote.git(worker, repositoryPath, ["rev-parse", `${project.deliveryRemote}/${project.defaultBranch}`]);
  const baseSha = base.stdout.trim();
  if (base.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseSha)) return { ok: false, reason: "Cannot resolve a fixed base SHA." };
  const mkdir = await remote.mkdir(worker, `${repositoryPath}.clawbridge-worktrees`);
  if (mkdir.exitCode !== 0) return { ok: false, reason: `Cannot create worktree directory: ${mkdir.stderr.slice(-1_000)}` };
  if (requeue) {
    const cleanup = await cleanupRequeuedWorktree(remote, worker, repositoryPath, worktreePath, branch, requeue.priorBaseSha);
    if (!cleanup.ok) return cleanup;
  }
  const created = await remote.git(worker, repositoryPath, ["worktree", "add", "--detach", worktreePath, baseSha]);
  if (created.exitCode !== 0) return { ok: false, reason: `Cannot create task worktree: ${created.stderr.slice(-1_000)}` };
  const checkout = await remote.git(worker, worktreePath, ["switch", "-c", branch]);
  if (checkout.exitCode !== 0) return { ok: false, reason: `Cannot create task branch: ${checkout.stderr.slice(-1_000)}` };
  return { ok: true, worktreePath, baseSha, branch };
}

/** A reconciled retry may reuse a taskId only when its previous worktree has no work to lose. */
async function cleanupRequeuedWorktree(
  remote: GitPreparerRemote,
  worker: RegisteredWorker,
  repositoryPath: string,
  worktreePath: string,
  branch: string,
  priorBaseSha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const status = await remote.git(worker, worktreePath, ["status", "--porcelain"]);
  // A missing old worktree needs no cleanup. Other Git errors are not safe to ignore.
  if (status.exitCode !== 0) {
    if (/not a git repository|No such file or directory/i.test(status.stderr)) return { ok: true };
    return { ok: false, reason: `Cannot inspect reconciled task worktree: ${status.stderr.slice(-1_000)}` };
  }
  if (status.stdout.trim()) return { ok: false, reason: "Reconciled task worktree has uncommitted changes; preserve or inspect it before retrying." };
  const head = await remote.git(worker, worktreePath, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0 || head.stdout.trim() !== priorBaseSha) {
    return { ok: false, reason: "Reconciled task worktree has commits beyond its original base; preserve or inspect it before retrying." };
  }
  const removed = await remote.git(worker, repositoryPath, ["worktree", "remove", worktreePath]);
  if (removed.exitCode !== 0) return { ok: false, reason: `Cannot remove clean reconciled task worktree: ${removed.stderr.slice(-1_000)}` };
  const deleted = await remote.git(worker, repositoryPath, ["branch", "-D", branch]);
  if (deleted.exitCode !== 0) return { ok: false, reason: `Cannot remove reconciled task branch: ${deleted.stderr.slice(-1_000)}` };
  return { ok: true };
}
