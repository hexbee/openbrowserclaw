# GitHub Skill Bulk Import Design

Date: 2026-02-28
Project: OpenBrowserClaw

## Goal

Extend the Skills page GitHub install flow so a user can paste a GitHub URL that points either to:

- a single skill directory
- a repository root containing `SKILL.md`
- a parent directory containing many skill subdirectories

When the URL points to a parent directory, the app should discover installable skills and let the user choose which ones to install.

## Confirmed Product Decisions

- Keep the existing single GitHub URL input as the only entry point
- Auto-detect whether the URL is a single skill target or a parent directory
- For parent directories, open a selection modal instead of installing immediately
- Default selection state is empty
- Provide `Select all` and `Clear all`

## Scope

This iteration adds:

- Parent directory detection for GitHub URLs
- Discovery of installable child skills under a directory
- Selection UI for batch installation
- Batch install execution with per-skill success, skip, and failure handling

This iteration does not add:

- Recursive deep discovery across arbitrary nested trees
- Private repository support
- Bulk update checking across a remote collection
- Merge handling for local modifications during install

## Current Constraints

- The app runs fully in the browser
- GitHub access uses HTTP APIs, not `git`
- Existing single-skill install behavior must remain unchanged
- Each installed skill must continue to own its own local directory and source metadata

## Chosen Approach

Use a single "smart install" flow:

1. Parse the GitHub URL into `{ owner, repo, ref, path }`
2. Read the target directory via the GitHub Contents API
3. If the directory contains `SKILL.md`, treat it as a single skill and install immediately
4. Otherwise, inspect the target directory's direct child directories only
5. For each direct child directory, check whether it contains `SKILL.md`
6. If one or more child skills are found, present them in a modal for selective install
7. Install only the checked skills, reusing the existing single-skill bundle download/write path

This keeps the current UX for single-skill installs while adding a selective batch mode for skill collections.

## Discovery Rules

The detection logic is:

- `single` target:
  The requested directory itself contains `SKILL.md`
- `collection` target:
  The requested directory does not contain `SKILL.md`, but one or more direct child directories do
- `invalid` target:
  Neither condition is true

Important boundary:

- Only direct child directories are scanned for installable skills
- The app does not recursively crawl the entire repository tree

This avoids excessive GitHub API usage and matches the common `skills/<skill-name>/` repository layout.

## Data Returned By Discovery

For collection targets, each discovered item should include:

- `name`
- `description`
- `path`
- `originalUrl`
- `alreadyInstalled`

`name` and `description` come from the child directory's `SKILL.md` frontmatter.

This metadata is enough to render a picker without downloading the full skill contents yet.

## UI Design

The existing `Install from GitHub` input and button remain unchanged.

Flow after clicking `Install`:

- Single skill target:
  Install immediately, as today
- Collection target:
  Open a modal named `Select skills to install`

The modal should include:

- Source label showing `owner/repo@ref/path`
- Search input for filtering discovered skills by name
- `Select all`
- `Clear all`
- Scrollable list of discovered skills
- Per-row checkbox
- Skill name
- Skill description
- Installed badge or disabled state for already installed skills
- Footer actions:
  - `Install selected`
  - `Cancel`

Selection behavior:

- Initial state is all unchecked
- Already installed skills are shown but disabled
- `Install selected` is disabled when no installable items are selected

## Install Execution

Batch installation should run per skill, not as one all-or-nothing transaction.

Rules:

- Each selected skill is installed independently
- Existing local skills are marked `skipped`
- A failure on one skill does not stop the rest
- At the end, the UI shows a summary such as:
  - `3 installed, 1 skipped, 1 failed`
- After completion:
  - refresh the skill registry
  - refresh the Skills page list
  - auto-select the first successfully installed skill if there is one

## Error Handling

### Parse / Discovery Phase

- Invalid URL:
  show a direct validation error
- GitHub request failure:
  surface status and message
- Target is neither single nor collection:
  show `No installable skills found in this GitHub directory`
- Partial child-directory scan failures:
  keep successful discoveries and show a warning that some directories could not be checked

### Install Phase

- Duplicate local skill name:
  mark as `skipped`
- GitHub file download failure:
  mark that skill as `failed`
- Write failure to OPFS:
  mark that skill as `failed`
- Mixed results:
  preserve per-skill statuses and show aggregate counts

## State Model

Add UI state for:

- discovered collection target metadata
- modal open/closed state
- selected discovered skill names
- per-skill batch install result
- optional discovery warning

The existing installed skill metadata file format remains unchanged:

`skills/<skill-name>/.openbrowserclaw-source.json`

Each installed skill still stores its own origin independently, even when multiple skills came from the same parent directory URL.

## Implementation Split

### Skill Management Layer

In `src/skill-management.ts`, add:

- URL resolution that returns a normalized GitHub target
- target classification:
  - `single`
  - `collection`
  - `invalid`
- direct-child skill discovery helpers
- lightweight frontmatter extraction for collection items
- batch install helper that reuses existing single-skill install primitives

Suggested functions:

- `resolveGitHubInstallTarget(rawUrl)`
- `discoverGitHubSkillsInDirectory(target)`
- `installSelectedGitHubSkills(items)`

The current single-skill bundle fetch/write helpers should remain the source of truth for actual installation.

### Skills Page

In `src/components/skills/SkillsPage.tsx`, add:

- branching behavior after GitHub URL submission
- discovery loading state
- selection modal
- search/filter within the discovered list
- batch install execution and summary reporting

The current install area remains the user entry point.

## API Efficiency Notes

Collection discovery requires more requests than single-skill install, so limits matter.

To keep usage reasonable:

- scan only direct children
- fetch only the child directory listing first
- fetch child `SKILL.md` only for directories that look like candidates
- avoid full file bundle downloads until the user confirms installation

This keeps the expensive recursive fetch limited to the chosen skills only.

## Testing

Add coverage for:

- repo root URL with `SKILL.md`
- single skill directory URL
- collection directory URL with multiple child skills
- collection directory with zero skills
- already installed child skills shown as disabled or skipped
- partial batch failure not aborting remaining installs
- persisted metadata for each installed skill remains valid

## Open Follow-Ups

- Whether to show child directory names in addition to skill names
- Whether to keep a recent collection source list for quick re-imports
- Whether to support nested collections in a later iteration
