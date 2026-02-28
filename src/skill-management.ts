import { OPFS_SKILLS_ROOT } from './config.js';
import { getOpfsRoot } from './opfs.js';
import type {
  GitHubBulkInstallResult,
  GitHubDiscoveredSkill,
  GitHubSkillForceUpdateResult,
  GitHubSkillForceUpdatePreview,
  GitHubSkillLocalChanges,
  GitHubSkillInstallDiscovery,
  GitHubRateLimitStatus,
  GitHubSkillSourceFile,
  GitHubSkillSourceMetadata,
  GitHubSkillUpdateCheckResult,
} from './types.js';

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_METADATA_FILENAME = '.openbrowserclaw-source.json';
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_FETCH_TIMEOUT_MS = 15000;

export const NEW_SKILL_TEMPLATE = `---
name: {{name}}
description: Describe what this skill does.
license: MIT
---

# {{title}}

When to use:
- 

Steps:
1. 
`;

interface GitHubRepoTarget {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  originalUrl: string;
}

interface GitHubRepositoryInfo {
  default_branch?: string;
}

interface GitHubDirectoryEntry {
  name: string;
  path: string;
  sha: string;
  url: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

interface GitHubFileEntry {
  name: string;
  path: string;
  sha: string;
  type: 'file';
  content?: string;
  encoding?: string;
}

interface GitHubInstallResult {
  skillName: string;
  fileCount: number;
}

interface GitHubSkillSnapshot {
  skillName: string;
  files: Array<{ path: string; sha: string }>;
}

interface ParsedSkillFrontmatter {
  name: string;
  description: string;
}

export function validateSkillName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required';
  if (trimmed.length > 64) return 'Name must be 64 characters or fewer';
  if (!SKILL_NAME_RE.test(trimmed)) {
    return 'Use lowercase letters, numbers, and single hyphens only';
  }
  return null;
}

export async function listUserSkillNames(): Promise<string[]> {
  const root = await getOpfsRoot();
  let skillsDir: FileSystemDirectoryHandle;
  try {
    skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT);
  } catch {
    return [];
  }

  const names: string[] = [];
  for await (const [name, handle] of skillsDir.entries()) {
    if (handle.kind === 'directory') names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function readUserSkillMarkdown(skillName: string): Promise<string> {
  const skillDir = await getUserSkillDir(skillName, false);
  const file = await skillDir.getFileHandle('SKILL.md');
  return (await file.getFile()).text();
}

export async function writeUserSkillMarkdown(skillName: string, content: string): Promise<void> {
  const skillDir = await getUserSkillDir(skillName, true);
  const file = await skillDir.getFileHandle('SKILL.md', { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function createUserSkillScaffold(skillName: string): Promise<void> {
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(nameError);

  const root = await getOpfsRoot();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT, { create: true });
  const skillDir = await skillsDir.getDirectoryHandle(skillName, { create: true });

  await ensureDirWithKeep(skillDir, 'scripts');
  await ensureDirWithKeep(skillDir, 'references');
  await ensureDirWithKeep(skillDir, 'assets');

  const file = await skillDir.getFileHandle('SKILL.md', { create: true });
  const writable = await file.createWritable();
  const title = skillName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  await writable.write(NEW_SKILL_TEMPLATE.replace(/{{name}}/g, skillName).replace(/{{title}}/g, title));
  await writable.close();
}

export async function installSkillFromGitHubUrl(rawUrl: string): Promise<GitHubInstallResult> {
  const target = await parseGitHubSkillUrl(rawUrl);
  return installGitHubSkillTarget(target);
}

export async function discoverGitHubSkillInstallTarget(rawUrl: string): Promise<GitHubSkillInstallDiscovery> {
  const target = await parseGitHubSkillUrl(rawUrl);
  const rootEntries = await fetchGitHubDirectory(target.owner, target.repo, target.ref, target.path);
  if (rootEntries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
    return { kind: 'single' };
  }

  const childDirectories = rootEntries.filter((entry) => entry.type === 'dir');
  const existing = new Set(await listUserSkillNames());
  const warnings: string[] = [];
  const discovered = await Promise.all(childDirectories.map(async (entry) => {
    try {
      return await discoverGitHubSkillDirectory(target, entry.path, existing);
    } catch (err) {
      warnings.push(err instanceof Error ? `${entry.name}: ${err.message}` : `${entry.name}: ${String(err)}`);
      return null;
    }
  }));

  const skills = discovered
    .filter((item): item is GitHubDiscoveredSkill => item !== null)
    .sort((a, b) => a.skillName.localeCompare(b.skillName));
  if (skills.length === 0) {
    throw new Error('No installable skills found in this GitHub directory');
  }

  return {
    kind: 'collection',
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    path: target.path,
    originalUrl: target.originalUrl,
    skills,
    warnings: warnings.sort((a, b) => a.localeCompare(b)),
  };
}

export async function installSelectedGitHubSkills(skills: GitHubDiscoveredSkill[]): Promise<GitHubBulkInstallResult> {
  const results = await Promise.all(skills.map(async (skill) => {
    try {
      const installed = await installGitHubSkillTarget({
        owner: skill.owner,
        repo: skill.repo,
        ref: skill.ref,
        path: skill.path,
        originalUrl: skill.originalUrl,
      });
      return {
        skillName: installed.skillName,
        status: 'installed' as const,
        fileCount: installed.fileCount,
        message: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('Skill already exists:')) {
        return {
          skillName: skill.skillName,
          status: 'skipped' as const,
          fileCount: 0,
          message,
        };
      }
      return {
        skillName: skill.skillName,
        status: 'failed' as const,
        fileCount: 0,
        message,
      };
    }
  }));

  return { results };
}

export async function readGitHubSkillSourceMetadata(skillName: string): Promise<GitHubSkillSourceMetadata | null> {
  try {
    const raw = await readUserSkillFile(skillName, SOURCE_METADATA_FILENAME);
    const parsed = JSON.parse(raw) as Partial<GitHubSkillSourceMetadata>;
    if (
      parsed?.version !== 1 ||
      parsed?.type !== 'github' ||
      typeof parsed.owner !== 'string' ||
      typeof parsed.repo !== 'string' ||
      typeof parsed.ref !== 'string' ||
      typeof parsed.path !== 'string' ||
      typeof parsed.originalUrl !== 'string' ||
      typeof parsed.installedAt !== 'string' ||
      !Array.isArray(parsed.files)
    ) {
      return null;
    }

    return {
      version: 1,
      type: 'github',
      owner: parsed.owner,
      repo: parsed.repo,
      ref: parsed.ref,
      path: parsed.path,
      originalUrl: parsed.originalUrl,
      installedAt: parsed.installedAt,
      files: parsed.files
        .filter((file): file is GitHubSkillSourceFile =>
          !!file &&
          typeof file.path === 'string' &&
          typeof file.sha === 'string')
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  } catch {
    return null;
  }
}

export async function checkGitHubSkillUpdate(skillName: string): Promise<GitHubSkillUpdateCheckResult> {
  const metadata = await readGitHubSkillSourceMetadata(skillName);
  if (!metadata) {
    throw new Error(`Skill is not GitHub-installed: ${skillName}`);
  }

  const target: GitHubRepoTarget = {
    owner: metadata.owner,
    repo: metadata.repo,
    ref: metadata.ref,
    path: metadata.path,
    originalUrl: metadata.originalUrl,
  };
  const snapshot = await fetchGitHubSkillSnapshot(target);
  if (snapshot.skillName !== skillName) {
    throw new Error(`Remote skill name changed from ${skillName} to ${snapshot.skillName}`);
  }

  return diffGitHubSkillMetadata(skillName, metadata, target, snapshot.files);
}

export async function forceUpdateGitHubSkill(skillName: string): Promise<GitHubSkillForceUpdateResult> {
  const metadata = await readGitHubSkillSourceMetadata(skillName);
  if (!metadata) {
    throw new Error(`Skill is not GitHub-installed: ${skillName}`);
  }

  const target: GitHubRepoTarget = {
    owner: metadata.owner,
    repo: metadata.repo,
    ref: metadata.ref,
    path: metadata.path,
    originalUrl: metadata.originalUrl,
  };
  const bundle = await fetchGitHubSkillBundle(target);
  if (bundle.skillName !== skillName) {
    throw new Error(`Remote skill name changed from ${skillName} to ${bundle.skillName}`);
  }

  const diff = diffGitHubSkillMetadata(skillName, metadata, target, bundle.files);
  await deleteUserSkill(skillName);
  const skillDir = await getUserSkillDir(skillName, true);
  await writeGitHubSkillBundle(skillDir, target, bundle.files);

  const nextMetadata: GitHubSkillSourceMetadata = {
    version: 1,
    type: 'github',
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    path: target.path,
    originalUrl: target.originalUrl,
    installedAt: new Date().toISOString(),
    files: bundle.files.map<GitHubSkillSourceFile>(({ path, sha }) => ({
      path: toRelativeSkillPath(target.path, path),
      sha,
    })),
  };
  await writeSkillFileText(skillDir, SOURCE_METADATA_FILENAME, JSON.stringify(nextMetadata, null, 2));

  return {
    ...diff,
    fileCount: bundle.files.length,
    remoteFileCount: bundle.files.length,
  };
}

export async function previewGitHubSkillForceUpdate(skillName: string): Promise<GitHubSkillForceUpdatePreview> {
  const metadata = await readGitHubSkillSourceMetadata(skillName);
  if (!metadata) {
    throw new Error(`Skill is not GitHub-installed: ${skillName}`);
  }

  const localChanges = await detectLocalGitHubSkillChanges(skillName, metadata);
  return {
    skillName,
    localChanges,
    hasLocalChanges:
      localChanges.modified.length > 0 ||
      localChanges.missing.length > 0 ||
      localChanges.untracked.length > 0,
  };
}

export async function getGitHubRateLimitStatus(): Promise<GitHubRateLimitStatus> {
  const response = await fetchWithTimeout(`${GITHUB_API_BASE}/rate_limit`, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw await buildGitHubRequestError(response, 'rate limit');
  }

  const limitHeader = response.headers.get('x-ratelimit-limit');
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  const resetHeader = response.headers.get('x-ratelimit-reset');

  return {
    limit: parseNumericHeader(limitHeader),
    remaining: parseNumericHeader(remainingHeader),
    resetAt: resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : null,
  };
}

export async function deleteUserSkill(skillName: string): Promise<void> {
  const root = await getOpfsRoot();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT);
  await skillsDir.removeEntry(skillName, { recursive: true });
}

async function ensureDirWithKeep(
  parent: FileSystemDirectoryHandle,
  child: string,
): Promise<void> {
  const dir = await parent.getDirectoryHandle(child, { create: true });
  const keep = await dir.getFileHandle('.gitkeep', { create: true });
  const writable = await keep.createWritable();
  await writable.write('');
  await writable.close();
}

async function getUserSkillDir(
  skillName: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(nameError);
  const root = await getOpfsRoot();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT, { create });
  return skillsDir.getDirectoryHandle(skillName, { create });
}

async function readUserSkillFile(skillName: string, relativePath: string): Promise<string> {
  const skillDir = await getUserSkillDir(skillName, false);
  const file = await skillDir.getFileHandle(relativePath);
  return (await file.getFile()).text();
}

async function detectLocalGitHubSkillChanges(
  skillName: string,
  metadata: GitHubSkillSourceMetadata,
): Promise<GitHubSkillLocalChanges> {
  const skillDir = await getUserSkillDir(skillName, false);
  const localEntries = await listSkillFiles(skillDir);
  const localRelevant = localEntries.filter((path) => path !== SOURCE_METADATA_FILENAME).sort((a, b) => a.localeCompare(b));
  const metadataByPath = new Map(metadata.files.map((file) => [file.path, file.sha]));
  const localSet = new Set(localRelevant);
  const modified: string[] = [];
  const missing: string[] = [];
  const untracked: string[] = [];

  for (const file of metadata.files) {
    if (!localSet.has(file.path)) {
      missing.push(file.path);
      continue;
    }

    const bytes = await readUserSkillFileBytes(skillName, file.path);
    const localSha = await computeGitBlobSha(bytes);
    if (localSha !== file.sha) {
      modified.push(file.path);
    }
  }

  for (const path of localRelevant) {
    if (!metadataByPath.has(path)) {
      untracked.push(path);
    }
  }

  return { modified, missing, untracked };
}

async function collectGitHubFiles(
  target: GitHubRepoTarget,
  directoryPath: string,
  files: Array<{ path: string; sha: string; bytes: Uint8Array }>,
): Promise<void> {
  const entries = await fetchGitHubDirectory(target.owner, target.repo, target.ref, directoryPath);
  await Promise.all(entries.map(async (entry) => {
    if (entry.type === 'dir') {
      await collectGitHubFiles(target, entry.path, files);
      return;
    }

    const bytes = await fetchGitHubFileBytes(entry.url);
    files.push({
      path: entry.path,
      sha: entry.sha,
      bytes,
    });
  }));
}

async function collectGitHubFileShas(
  target: GitHubRepoTarget,
  directoryPath: string,
  files: Array<{ path: string; sha: string }>,
): Promise<void> {
  const entries = await fetchGitHubDirectory(target.owner, target.repo, target.ref, directoryPath);
  await Promise.all(entries.map(async (entry) => {
    if (entry.type === 'dir') {
      await collectGitHubFileShas(target, entry.path, files);
      return;
    }

    files.push({
      path: entry.path,
      sha: entry.sha,
    });
  }));
}

async function fetchGitHubSkillBundle(
  target: GitHubRepoTarget,
): Promise<{ skillName: string; files: Array<{ path: string; sha: string; bytes: Uint8Array }> }> {
  const rootEntries = await fetchGitHubDirectory(target.owner, target.repo, target.ref, target.path);
  const skillMarkdownEntry = rootEntries.find((entry) => entry.type === 'file' && entry.name === 'SKILL.md');
  if (!skillMarkdownEntry) {
    throw new Error('Target directory must contain SKILL.md');
  }

  const skillMarkdownBytes = await fetchGitHubFileBytes(skillMarkdownEntry.url);
  const skillMarkdown = new TextDecoder().decode(skillMarkdownBytes);
  const parsedSkill = parseSkillFrontmatter(skillMarkdown);
  const skillName = parsedSkill.name;
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(`Invalid skill name in SKILL.md: ${nameError}`);

  const remoteDirName = target.path.split('/').filter(Boolean).pop();
  if (remoteDirName && remoteDirName !== skillName) {
    throw new Error('GitHub directory name must match the skill name declared in SKILL.md');
  }

  const files: Array<{ path: string; sha: string; bytes: Uint8Array }> = [];
  await collectGitHubFiles(target, target.path, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { skillName, files };
}

async function fetchGitHubSkillSnapshot(target: GitHubRepoTarget): Promise<GitHubSkillSnapshot> {
  const rootEntries = await fetchGitHubDirectory(target.owner, target.repo, target.ref, target.path);
  const skillMarkdownEntry = rootEntries.find((entry) => entry.type === 'file' && entry.name === 'SKILL.md');
  if (!skillMarkdownEntry) {
    throw new Error('Target directory must contain SKILL.md');
  }

  const skillMarkdownBytes = await fetchGitHubFileBytes(skillMarkdownEntry.url);
  const skillMarkdown = new TextDecoder().decode(skillMarkdownBytes);
  const parsedSkill = parseSkillFrontmatter(skillMarkdown);
  const skillName = parsedSkill.name;
  const nameError = validateSkillName(skillName);
  if (nameError) throw new Error(`Invalid skill name in SKILL.md: ${nameError}`);

  const remoteDirName = target.path.split('/').filter(Boolean).pop();
  if (remoteDirName && remoteDirName !== skillName) {
    throw new Error('GitHub directory name must match the skill name declared in SKILL.md');
  }

  const files: Array<{ path: string; sha: string }> = [];
  await collectGitHubFileShas(target, target.path, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { skillName, files };
}

function diffGitHubSkillMetadata(
  skillName: string,
  metadata: GitHubSkillSourceMetadata,
  target: GitHubRepoTarget,
  remoteBundleFiles: Array<{ path: string; sha: string }>,
): GitHubSkillUpdateCheckResult {
  const remoteFiles = remoteBundleFiles
    .map(({ path, sha }) => ({ path: toRelativeSkillPath(target.path, path), sha }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const localByPath = new Map(metadata.files.map((file) => [file.path, file.sha]));
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file.sha]));

  for (const file of remoteFiles) {
    const localSha = localByPath.get(file.path);
    if (!localSha) {
      added.push(file.path);
    } else if (localSha !== file.sha) {
      modified.push(file.path);
    }
  }

  for (const file of metadata.files) {
    if (!remoteByPath.has(file.path)) {
      removed.push(file.path);
    }
  }

  return {
    skillName,
    updateAvailable: added.length > 0 || modified.length > 0 || removed.length > 0,
    added,
    modified,
    removed,
    remoteFileCount: remoteFiles.length,
  };
}

async function fetchGitHubDirectory(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<GitHubDirectoryEntry[]> {
  const encodedPath = path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const contentsPath = encodedPath ? `/contents/${encodedPath}` : '/contents';
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${contentsPath}?ref=${encodeURIComponent(ref)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw await buildGitHubRequestError(response, 'directory');
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('GitHub URL must point to a directory');
  }
  return payload as GitHubDirectoryEntry[];
}

async function discoverGitHubSkillDirectory(
  baseTarget: GitHubRepoTarget,
  directoryPath: string,
  existingSkills: Set<string>,
): Promise<GitHubDiscoveredSkill | null> {
  const entries = await fetchGitHubDirectory(baseTarget.owner, baseTarget.repo, baseTarget.ref, directoryPath);
  const skillMarkdownEntry = entries.find((entry) => entry.type === 'file' && entry.name === 'SKILL.md');
  if (!skillMarkdownEntry) {
    return null;
  }

  const skillMarkdownBytes = await fetchGitHubFileBytes(skillMarkdownEntry.url);
  const skillMarkdown = new TextDecoder().decode(skillMarkdownBytes);
  const parsedSkill = parseSkillFrontmatter(skillMarkdown);
  const nameError = validateSkillName(parsedSkill.name);
  if (nameError) {
    throw new Error(`Invalid skill name in SKILL.md: ${nameError}`);
  }

  const remoteDirName = directoryPath.split('/').filter(Boolean).pop();
  if (remoteDirName && remoteDirName !== parsedSkill.name) {
    throw new Error('GitHub directory name must match the skill name declared in SKILL.md');
  }

  return {
    skillName: parsedSkill.name,
    description: parsedSkill.description,
    owner: baseTarget.owner,
    repo: baseTarget.repo,
    ref: baseTarget.ref,
    path: directoryPath,
    originalUrl: buildGitHubTreeUrl(baseTarget.owner, baseTarget.repo, baseTarget.ref, directoryPath),
    alreadyInstalled: existingSkills.has(parsedSkill.name),
  };
}

async function fetchGitHubFileBytes(fileApiUrl: string): Promise<Uint8Array> {
  const response = await fetchWithTimeout(fileApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw await buildGitHubRequestError(response, 'file');
  }
  const payload = await response.json() as GitHubFileEntry;
  if (payload.type !== 'file') {
    throw new Error(`GitHub API did not return a file for ${fileApiUrl}`);
  }
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error(`GitHub file content is unavailable for ${payload.path}`);
  }

  return decodeBase64ToBytes(payload.content);
}

async function buildGitHubRequestError(
  response: Response,
  requestKind: 'directory' | 'file' | 'rate limit' | 'repository',
): Promise<Error> {
  const rateRemaining = response.headers.get('x-ratelimit-remaining');
  const rateReset = response.headers.get('x-ratelimit-reset');
  let detail = '';

  try {
    const payload = await response.clone().json() as { message?: string };
    if (payload?.message) {
      detail = payload.message;
    }
  } catch {
    // Ignore body parse failures and fall back to status-based messaging.
  }

  if (response.status === 403 && rateRemaining === '0') {
    const resetSuffix = rateReset
      ? ` Try again after ${new Date(Number(rateReset) * 1000).toLocaleTimeString()}.`
      : '';
    const requestLabel = requestKind === 'repository' ? 'repository metadata' : `${requestKind}s`;
    return new Error(`GitHub API rate limit exceeded while checking ${requestLabel}.${resetSuffix}`);
  }

  const suffix = detail ? `: ${detail}` : '';
  return new Error(`GitHub ${requestKind} request failed (${response.status})${suffix}`);
}

function parseNumericHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`GitHub request timed out after ${Math.round(GITHUB_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function decodeBase64ToBytes(content: string): Uint8Array {
  const normalized = content.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function installGitHubSkillTarget(target: GitHubRepoTarget): Promise<GitHubInstallResult> {
  const { skillName, files } = await fetchGitHubSkillBundle(target);

  const existing = await listUserSkillNames();
  if (existing.includes(skillName)) {
    throw new Error(`Skill already exists: ${skillName}`);
  }

  const skillDir = await getUserSkillDir(skillName, true);
  await writeGitHubSkillBundle(skillDir, target, files);

  const metadata: GitHubSkillSourceMetadata = {
    version: 1,
    type: 'github',
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    path: target.path,
    originalUrl: target.originalUrl,
    installedAt: new Date().toISOString(),
    files: files.map<GitHubSkillSourceFile>(({ path, sha }) => ({
      path: toRelativeSkillPath(target.path, path),
      sha,
    })),
  };
  await writeSkillFileText(skillDir, SOURCE_METADATA_FILENAME, JSON.stringify(metadata, null, 2));

  return {
    skillName,
    fileCount: files.length,
  };
}

async function parseGitHubSkillUrl(rawUrl: string): Promise<GitHubRepoTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Enter a valid GitHub URL');
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    throw new Error('Only github.com URLs are supported');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Use a GitHub repo URL like https://github.com/owner/repo or a directory URL');
  }

  const [owner, repo, third, fourth, ...rest] = parts;
  if (!owner || !repo) {
    throw new Error('Use a GitHub repo URL like https://github.com/owner/repo or a directory URL');
  }

  if (!third) {
    return {
      owner,
      repo,
      ref: await fetchGitHubDefaultBranch(owner, repo),
      path: '',
      originalUrl: url.toString(),
    };
  }

  if (third !== 'tree' || !fourth) {
    throw new Error('Use a GitHub repo URL like https://github.com/owner/repo or a directory URL');
  }

  const ref = fourth;
  const path = rest.join('/');

  return {
    owner,
    repo,
    ref,
    path,
    originalUrl: url.toString(),
  };
}

async function fetchGitHubDefaultBranch(owner: string, repo: string): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw await buildGitHubRequestError(response, 'repository');
  }

  const payload = await response.json() as GitHubRepositoryInfo;
  if (typeof payload.default_branch !== 'string' || !payload.default_branch) {
    throw new Error('GitHub repository metadata did not include a default branch');
  }

  return payload.default_branch;
}

function parseSkillFrontmatter(markdown: string): ParsedSkillFrontmatter {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const frontmatterMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }

  const nameMatch = frontmatterMatch[1].match(/(?:^|\r?\n)name:\s*("?)([a-z0-9]+(?:-[a-z0-9]+)*)\1(?:\r?\n|$)/);
  if (!nameMatch) {
    throw new Error('SKILL.md frontmatter must define name');
  }

  const descriptionMatch = frontmatterMatch[1].match(/(?:^|\r?\n)description:\s*("?)(.*?)\1(?:\r?\n|$)/);
  return {
    name: nameMatch[2],
    description: descriptionMatch?.[2]?.trim() ?? '',
  };
}

function buildGitHubTreeUrl(owner: string, repo: string, ref: string, path: string): string {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '');
  const encodedSegments = normalizedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  if (encodedSegments.length === 0) {
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}/${encodedSegments.join('/')}`;
}

function toRelativeSkillPath(rootPath: string, fullPath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const normalizedFullPath = fullPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalizedRoot) {
    return normalizedFullPath;
  }
  if (normalizedFullPath === normalizedRoot) {
    throw new Error('Invalid skill file path');
  }
  const prefix = `${normalizedRoot}/`;
  if (!normalizedFullPath.startsWith(prefix)) {
    throw new Error(`File path is outside the requested skill directory: ${fullPath}`);
  }
  return normalizedFullPath.slice(prefix.length);
}

async function writeGitHubSkillBundle(
  skillDir: FileSystemDirectoryHandle,
  target: GitHubRepoTarget,
  files: Array<{ path: string; sha: string; bytes: Uint8Array }>,
): Promise<void> {
  for (const file of files) {
    const relativePath = toRelativeSkillPath(target.path, file.path);
    await writeSkillFileBytes(skillDir, relativePath, file.bytes);
  }
}

async function listSkillFiles(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<string[]> {
  const files: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    const nextPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      files.push(nextPath);
      continue;
    }
    files.push(...await listSkillFiles(handle, nextPath));
  }
  return files;
}

async function readUserSkillFileBytes(skillName: string, relativePath: string): Promise<Uint8Array> {
  const skillDir = await getUserSkillDir(skillName, false);
  const parts = relativePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Invalid file path');

  let dir = skillDir;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }

  const file = await dir.getFileHandle(filename);
  return new Uint8Array(await (await file.getFile()).arrayBuffer());
}

async function computeGitBlobSha(bytes: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.length + bytes.length);
  payload.set(header, 0);
  payload.set(bytes, header.length);
  const digest = await crypto.subtle.digest('SHA-1', payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function writeSkillFileBytes(
  skillDir: FileSystemDirectoryHandle,
  relativePath: string,
  content: Uint8Array,
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Invalid file path');

  let dir = skillDir;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }

  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  const normalized = new Uint8Array(content.byteLength);
  normalized.set(content);
  await writable.write(normalized);
  await writable.close();
}

async function writeSkillFileText(
  skillDir: FileSystemDirectoryHandle,
  relativePath: string,
  content: string,
): Promise<void> {
  const file = await skillDir.getFileHandle(relativePath, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}
