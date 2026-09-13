import assert from "node:assert/strict";
import test from "node:test";
import { buildDevelopmentPrompt } from "../src/handoff.js";

test("development prompt contains the immutable handoff details", () => {
  const prompt = buildDevelopmentPrompt({
    repositoryUrl: "https://example.com/org/repo.git",
    baseBranch: "main",
    workBranch: "workbuddy/add-login",
    specPath: ".agent-handoff/SPEC.md",
    testCommand: "npm test",
  });
  assert.match(prompt, /workbuddy\/add-login/);
  assert.match(prompt, /\.agent-handoff\/SPEC\.md/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Never merge it/i);
  assert.match(prompt, /exactly one JSON object/i);
});
