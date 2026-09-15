import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const projectSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  repository: z.string().min(1).max(300),
  deliveryRemote: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).default("origin"),
  githubCredentialRef: z.string().min(1).max(120).optional(),
  defaultBranch: z.string().min(1).max(200),
  workerId: z.string().min(1).max(80),
  remoteRepositoryPath: z.string().min(1).max(1_024),
  requiredCapabilities: z.array(z.string().min(1).max(80)).default([]),
  testCommands: z.array(z.array(z.string().min(1))).default([]),
  buildCommands: z.array(z.array(z.string().min(1))).default([]),
  defaultModel: z.string().min(1).max(200).optional(),
  permissionProfile: z.string().min(1).max(80).optional(),
  allowedTools: z.array(z.string().min(1).max(300)).max(40).default([]),
  maxRuntimeMinutes: z.number().int().positive().max(24 * 60).default(120),
  maxRepairRounds: z.number().int().min(0).max(10).default(1),
  maxConcurrentJobs: z.number().int().positive().max(32).default(1),
}).strict();

const workerSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  sshHost: z.string().min(1).max(300),
  gatewayPort: z.number().int().min(1).max(65535).default(8080),
  codebuddyExecutable: z.string().min(1).max(1_024),
  allowedRoots: z.array(z.string().min(1).max(1_024)).min(1),
  capabilities: z.array(z.string().min(1).max(80)).default([]),
  maxConcurrentJobs: z.number().int().positive().max(32).default(1),
  credentialRef: z.string().min(1).max(120).optional(),
}).strict();

const registrySchema = z.object({
  schemaVersion: z.literal(1),
  workers: z.array(workerSchema).default([]),
  projects: z.array(projectSchema).default([]),
}).strict().superRefine((value, context) => {
  const workerIds = new Set<string>();
  for (const worker of value.workers) {
    if (workerIds.has(worker.id)) context.addIssue({ code: "custom", message: `Duplicate worker id: ${worker.id}` });
    workerIds.add(worker.id);
  }
  const projectIds = new Set<string>();
  for (const project of value.projects) {
    if (projectIds.has(project.id)) context.addIssue({ code: "custom", message: `Duplicate project id: ${project.id}` });
    projectIds.add(project.id);
    if (!workerIds.has(project.workerId)) {
      context.addIssue({ code: "custom", message: `Project ${project.id} references unknown worker ${project.workerId}` });
    }
  }
});

export type RegisteredProject = z.infer<typeof projectSchema>;
export type RegisteredWorker = z.infer<typeof workerSchema>;
export type ProjectSummary = Pick<RegisteredProject, "id" | "repository" | "defaultBranch" | "workerId" | "requiredCapabilities" | "defaultModel" | "maxRuntimeMinutes">;

export class ProjectRegistry {
  private constructor(
    private readonly projects: Map<string, RegisteredProject>,
    private readonly workers: Map<string, RegisteredWorker>,
    readonly sourceFile: string,
  ) {}

  static load(sourceFile: string): ProjectRegistry {
    if (!fs.existsSync(sourceFile)) return new ProjectRegistry(new Map(), new Map(), sourceFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read ClawBridge project registry ${sourceFile}: ${message(error)}`);
    }
    const result = registrySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid ClawBridge project registry ${sourceFile}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return new ProjectRegistry(
      new Map(result.data.projects.map((project) => [project.id, project])),
      new Map(result.data.workers.map((worker) => [worker.id, worker])),
      sourceFile,
    );
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()].map(({ id, repository, defaultBranch, workerId, requiredCapabilities, defaultModel, maxRuntimeMinutes }) =>
      ({ id, repository, defaultBranch, workerId, requiredCapabilities, defaultModel, maxRuntimeMinutes }),
    );
  }

  get(projectId: string): RegisteredProject | undefined {
    return this.projects.get(projectId);
  }

  workerFor(projectId: string): RegisteredWorker {
    const project = this.require(projectId);
    const worker = this.workers.get(project.workerId);
    if (!worker) throw new Error(`Project worker ${project.workerId} is not registered.`);
    return worker;
  }

  allowsPath(projectId: string, candidate: string): boolean {
    const worker = this.workerFor(projectId);
    return worker.allowedRoots.some((root) => isWithinRoot(candidate, root));
  }

  require(projectId: string): RegisteredProject {
    const project = this.get(projectId);
    if (!project) throw new Error(`Unknown project id ${projectId}. Register it in ${this.sourceFile}.`);
    return project;
  }

  preflight(projectId: string): { ready: boolean; blockers: string[]; warnings: string[] } {
    const project = this.get(projectId);
    if (!project) return { ready: false, blockers: [`Unknown project id ${projectId}.`], warnings: [] };
    const worker = this.workers.get(project.workerId);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!worker) blockers.push(`Project worker ${project.workerId} is not registered.`);
    if (!path.isAbsolute(project.remoteRepositoryPath)) blockers.push("remoteRepositoryPath must be absolute.");
    if (worker && !worker.allowedRoots.some((root) => isWithinRoot(project.remoteRepositoryPath, root))) {
      blockers.push("remoteRepositoryPath is outside the worker's allowedRoots.");
    }
    if (project.testCommands.length === 0) warnings.push("No testCommands are registered.");
    if (project.buildCommands.length === 0) warnings.push("No buildCommands are registered.");
    return { ready: blockers.length === 0, blockers, warnings };
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
