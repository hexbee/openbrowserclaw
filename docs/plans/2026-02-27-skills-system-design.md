# Skills System Design (Agent Skills Compatible)

Date: 2026-02-27
Project: OpenBrowserClaw

## Goals

Implement full Agent Skills compatibility in OpenBrowserClaw with:
- Dual-source skill discovery (built-in + user-added)
- Progressive disclosure (metadata at startup, full SKILL.md on activation)
- Both activation modes:
  - Automatic model-selected activation
  - Explicit activation via tool call
- Resource access for skill-bundled files (`scripts/`, `references/`, `assets/`)

## External References

- What are skills: https://agentskills.io/what-are-skills
- Specification: https://agentskills.io/specification
- Integrate skills: https://agentskills.io/integrate-skills

## Scope Confirmed With User

- Must support both built-in and user-defined skills
- Must support both automatic and explicit activation
- Must target full spec compatibility
- Do not add mandatory high-risk command confirmation in this iteration

## Functional Requirements

1. Discovery
- The system discovers skills from:
  - Built-in: `public/skills/<skill-name>/SKILL.md`
  - User: OPFS under `skills/<skill-name>/SKILL.md`
- A skill is valid only if `SKILL.md` exists with YAML frontmatter.

2. Metadata loading (startup)
- Parse only frontmatter fields at initialization.
- Keep body unloaded until activation.

3. Metadata injection
- Add `<available_skills>` to system prompt.
- Include `<name>`, `<description>`, `<location>` for each valid skill.

4. Activation
- Automatic activation path: model chooses relevant skill from prompt metadata and activates it.
- Explicit activation path: model can call `activate_skill` tool.
- Activation loads full SKILL.md content into context.

5. Resource loading
- Provide tool to read files inside activated skill root by relative path.
- Support optional directories from spec: `scripts/`, `references/`, `assets/`.

6. Conflict resolution
- If both sources contain same skill name, user skill overrides built-in skill.

## Specification Compatibility Rules

From https://agentskills.io/specification:

- `name` (required)
  - 1-64 characters
  - lowercase alphanumeric + hyphen
  - cannot start/end with hyphen
  - no consecutive hyphens
  - must match parent directory name
- `description` (required)
  - 1-1024 characters
- `license` (optional)
- `compatibility` (optional, 1-500 chars if present)
- `metadata` (optional map<string,string>)
- `allowed-tools` (optional, space-delimited; experimental)

Non-conforming skills are marked invalid and excluded from prompt metadata.

## Architecture Changes

### New module: `src/skills.ts`

Responsibilities:
- Discover built-in and user skill directories
- Parse frontmatter and validate against spec
- Build and cache a unified registry
- Resolve source precedence
- Provide APIs for worker/tool use:
  - list skills
  - activate skill
  - read skill resource

### Type additions (`src/types.ts`)

New types:
- `SkillSource = 'builtin' | 'user'`
- `SkillFrontmatter`
- `SkillRecord`
- `SkillValidationError`
- `SkillsContext`

### Config additions (`src/config.ts`)

- Built-in skills base path
- User skills root path in OPFS

### Orchestrator integration (`src/orchestrator.ts`)

- Initialize skills registry during `init()`
- Include available skills XML in system prompt
- Pass serialized skills context to worker invoke payload

### Worker integration (`src/agent-worker.ts`, `src/tools.ts`)

Add tools:
- `list_skills`
- `activate_skill`
- `read_skill_resource`

Behavior:
- `list_skills`: returns valid skills and source info
- `activate_skill`: loads full SKILL.md and returns instructions payload
- `read_skill_resource`: reads relative file under active skill root with traversal protection

## Security & Safety

- Path traversal prevention for resource reads (`..`, absolute paths, backslash normalization)
- Invalid skills never exposed to model metadata
- Failed skill parse does not crash agent; errors are surfaced in diagnostics

## UI Changes

Minimal Settings updates:
- Display skills summary (count by source, invalid count)
- Manual refresh button to reload registry

## Testing Plan

1. Static/type checks
- `npm run typecheck`

2. Manual scenarios
- Built-in skill appears in metadata and can activate
- User-added skill appears and can activate
- User skill overrides built-in same-name skill
- Invalid frontmatter skill excluded
- Resource read blocks path traversal

3. Regression checks
- Existing tool-use loop unchanged for non-skill usage
- Existing chat and task flows unaffected

## Rollout Notes

This feature is additive and backwards-compatible. If no skills exist, behavior remains unchanged except for zero-entry skills metadata section.
