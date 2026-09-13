export interface DevelopmentHandoff {
  repositoryUrl: string;
  baseBranch: string;
  workBranch: string;
  specPath: string;
  testCommand?: string;
  additionalInstructions?: string;
}

export function buildDevelopmentPrompt(input: DevelopmentHandoff): string {
  const tests = input.testCommand
    ? `Run this verification command before committing: ${input.testCommand}`
    : "Discover and run the repository's relevant tests and static checks before committing.";
  const additional = input.additionalInstructions
    ? `\nAdditional constraints:\n${input.additionalInstructions.trim()}\n`
    : "";

  return `You are the implementation worker in a reviewed Git handoff.

Repository: ${input.repositoryUrl}
Base branch: ${input.baseBranch}
Implementation branch: ${input.workBranch}
Specification file: ${input.specPath}

Instructions:
1. Clone or update the repository and start from the latest ${input.baseBranch}.
2. Create or reset only the implementation branch ${input.workBranch}; do not modify or force-push any other branch.
3. Read ${input.specPath} and implement only its requirements.
4. Preserve unrelated user changes and never commit credentials or generated dependency directories.
5. ${tests}
6. Review the diff for scope, correctness, and secrets.
7. Commit and push ${input.workBranch}. Never merge it.
${additional}
When finished, reply with exactly one JSON object and no surrounding Markdown:
{
  "status": "completed" | "blocked",
  "branch": "${input.workBranch}",
  "commit": "commit SHA or empty string",
  "tests": {"command": "command run", "passed": true | false, "summary": "short result"},
  "open_issues": ["remaining issue"]
}`;
}
