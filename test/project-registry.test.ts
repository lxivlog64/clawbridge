import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectRegistry } from "../src/project-registry.js";

test("project registry validates a project against its worker allowlist", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawbridge-registry-"));
  const file = path.join(directory, "projects.json");
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    workers: [{
      id: "linux-dev", sshHost: "worker.example", gatewayPort: 8080,
      codebuddyExecutable: "/opt/codebuddy/bin/codebuddy", allowedRoots: ["/srv/projects"],
    }],
    projects: [{
      id: "sample-app", repository: "owner/sample-app", deliveryRemote: "origin", defaultBranch: "main", workerId: "linux-dev",
      remoteRepositoryPath: "/srv/projects/sample-app", requiredCapabilities: ["linux"],
    }],
  }));
  const registry = ProjectRegistry.load(file);
  assert.equal(registry.list().length, 1);
  assert.deepEqual(registry.preflight("sample-app"), {
    ready: true, blockers: [], warnings: ["No testCommands are registered.", "No buildCommands are registered."],
  });
  assert.equal(registry.preflight("missing").ready, false);
  await fs.rm(directory, { recursive: true, force: true });
});
