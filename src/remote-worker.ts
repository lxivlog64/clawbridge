import { spawn } from "node:child_process";
import type { RegisteredWorker } from "./project-registry.js";

export interface RemoteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a small fixed remote Node helper. Dynamic task text is serialized as base64url,
 * never interpolated into a remote shell command. */
export class RemoteWorker {
  constructor(private readonly runner: typeof spawn = spawn) {}

  async git(worker: RegisteredWorker, cwd: string, args: string[]): Promise<RemoteCommandResult> {
    return this.run(worker, "git", args, cwd);
  }

  async gh(worker: RegisteredWorker, cwd: string, args: string[]): Promise<RemoteCommandResult> {
    return this.run(worker, "gh", args, cwd);
  }

  private async run(worker: RegisteredWorker, program: "git" | "gh", args: string[], cwd: string): Promise<RemoteCommandResult> {
    const payload = Buffer.from(JSON.stringify({ program, args, cwd }), "utf8").toString("base64url");
    const helper = "const{spawnSync}=require('node:child_process');const p=JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));const r=spawnSync(p.program,p.args,{cwd:p.cwd,encoding:'utf8',timeout:120000});process.stdout.write(JSON.stringify({exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??r.error?.message??''}));";
    const command = `node -e ${shellQuote(helper)} ${payload}`;
    return new Promise((resolve, reject) => {
      const child = this.runner("ssh", ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", worker.sshHost, command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`Remote SSH command failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(-1_000)}`));
        try {
          const result = JSON.parse(Buffer.concat(output).toString("utf8")) as RemoteCommandResult;
          resolve({ ...result, stdout: result.stdout.slice(0, 64_000), stderr: result.stderr.slice(0, 8_000) });
        } catch {
          reject(new Error("Remote worker returned invalid command data."));
        }
      });
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
