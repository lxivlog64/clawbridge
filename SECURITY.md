# Security Policy

## Supported versions

Only the latest commit on the default branch is supported while the project is in its initial development stage.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature instead of opening a public issue. Do not include live credentials, private repository contents, or personal data in a report.

## Deployment guidance

- Bind the CodeBuddy Gateway to loopback and use an SSH tunnel for remote access.
- Keep password authentication enabled.
- Store OAuth secrets and Gateway credentials outside the repository.
- Limit CodeBuddy to a dedicated workspace directory.
- Review every returned Git diff and rerun tests before merging.
- Do not automatically approve destructive actions, external publication, deployment, or credential access.

The Gateway exposes process execution and filesystem capabilities. Treat access to it as equivalent to shell access on the worker machine.
