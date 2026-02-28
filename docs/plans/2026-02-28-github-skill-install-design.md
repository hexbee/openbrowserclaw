# GitHub Skill Install MVP

Date: 2026-02-28
Project: OpenBrowserClaw

## Goal

Improve the Skills page so a user can install a skill by pasting a public GitHub URL, without relying on `git` or any Node-side clone workflow.

## Scope

This iteration adds:
- Public GitHub directory URL install from the Skills page
- Recursive download of one skill directory into OPFS
- Install-time source metadata persisted locally for future update checks

This iteration does not add:
- Authenticated/private repository installs
- Bulk repository discovery
- Automatic merge/conflict handling during updates
- Protected merges for local modifications

## Confirmed Constraints

- The app runs in the browser and cannot depend on local `git` operations
- Existing manual skill creation must keep working
- The first update-related milestone is metadata capture, not full update UX

## Chosen Approach

Use GitHub's HTTP APIs directly from the browser:

1. Parse a GitHub directory URL in the form:
   `https://github.com/<owner>/<repo>/tree/<ref>/<path>`
2. Call the GitHub Contents API for that directory
3. Verify the directory contains `SKILL.md`
4. Read `name` from frontmatter and use it as the local skill directory name
5. Recursively fetch all files in that skill directory
6. Write those files into OPFS under `skills/<skill-name>/`
7. Persist a sidecar metadata file with the install source and remote file SHAs

## Data Model

Store install metadata at:

`skills/<skill-name>/.openbrowserclaw-source.json`

Fields:
- `version`
- `type = "github"`
- `owner`
- `repo`
- `ref`
- `path`
- `originalUrl`
- `installedAt`
- `files[]` with relative path + GitHub SHA

This keeps update foundations out of `SKILL.md` and preserves spec compatibility.

## UI Changes

The Skills page gets two entry points:
- `Install from GitHub`
- `Create manually`

The GitHub flow:
- Accepts a public GitHub directory URL
- Rejects unsupported URLs and duplicate skill names
- Refreshes the skill registry after install
- Selects the newly installed skill in the editor

## Error Handling

- Invalid URL: show a direct validation error
- Non-directory or missing `SKILL.md`: reject install
- Name mismatch between remote directory and frontmatter: reject install
- Existing local skill with same name: reject install
- GitHub API/file fetch failure: surface status-based error

## Update Behavior

GitHub-installed skills now support:
- `Check update` by diffing stored SHAs against the current GitHub directory
- `Force update` by re-fetching and overwriting the local skill directory

Rules:
- Only skills with `.openbrowserclaw-source.json` show update actions
- Manual skills do not expose update controls
- `Force update` first scans for local modified, missing, and untracked files
- `Force update` always requires a confirmation dialog before overwriting
- Local changes are warned about, but the user can still continue with overwrite
