---
name: openbrowserclaw-basics
description: Core project conventions and architecture map for OpenBrowserClaw.
license: MIT
metadata:
  owner: openbrowserclaw
  scope: repo
allowed-tools: read_file write_file list_files bash javascript
---

# OpenBrowserClaw Basics

Use this skill when working in this repository.

## Project Layout

- `src/orchestrator.ts`: main-thread state machine and worker orchestration.
- `src/agent-worker.ts`: tool-use loop and tool execution runtime.
- `src/tools.ts`: tool schema presented to the model.
- `src/storage.ts`: OPFS helpers.
- `src/db.ts`: IndexedDB persistence.

## Working Rules

- Prefer minimal changes that preserve current runtime behavior.
- Keep browser-only constraints in mind (no server dependencies).
- Run `npm run typecheck` after code changes.
