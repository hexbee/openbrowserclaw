import type {
  SkillFrontmatter,
  SkillRecord,
  SkillSource,
  SkillSummary,
  SkillValidationError,
} from './types.js';
import { OPFS_SKILLS_ROOT } from './config.js';

const BUILTIN_SKILL_BODIES = import.meta.glob('./builtin-skills/**/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BUILTIN_SKILL_FILES = import.meta.glob('./builtin-skills/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface ActivatedSkill {
  skill: SkillRecord;
  content: string;
}

export async function loadSkills(): Promise<SkillRecord[]> {
  const builtin = await loadBuiltinSkills();
  const user = await loadUserSkills();

  // User skill overrides built-in skill with same name.
  const merged = new Map<string, SkillRecord>();
  for (const skill of builtin) merged.set(skill.name, skill);
  for (const skill of user) merged.set(skill.name, skill);

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeSkills(skills: SkillRecord[]): SkillSummary {
  return {
    total: skills.length,
    valid: skills.filter((s) => s.valid).length,
    invalid: skills.filter((s) => !s.valid).length,
    builtin: skills.filter((s) => s.source === 'builtin').length,
    user: skills.filter((s) => s.source === 'user').length,
  };
}

export function buildAvailableSkillsXml(skills: SkillRecord[]): string {
  const valid = skills.filter((s) => s.valid);
  if (valid.length === 0) {
    return '<available_skills></available_skills>';
  }

  const lines = ['<available_skills>'];
  for (const skill of valid) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

export async function activateSkill(skillName: string): Promise<ActivatedSkill> {
  const skills = await loadSkills();
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);
  if (!skill.valid) throw new Error(`Skill is invalid: ${skillName}`);

  const parsed = skill.source === 'builtin'
    ? parseSkillMarkdown(readBuiltinSkillMarkdown(skillName))
    : parseSkillMarkdown(await readUserSkillFile(skillName, 'SKILL.md'));

  return {
    skill,
    content: parsed.body.trim(),
  };
}

export async function readSkillResource(skillName: string, relativePath: string): Promise<string> {
  const safePath = normalizeRelativePath(relativePath);
  if (safePath === 'SKILL.md') {
    throw new Error('Use activate_skill for SKILL.md content.');
  }

  const skills = await loadSkills();
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Skill not found: ${skillName}`);

  if (skill.source === 'builtin') {
    return readBuiltinSkillFile(skillName, safePath);
  }
  return readUserSkillFile(skillName, safePath);
}

export async function writeUserSkillFile(
  skillName: string,
  relativePath: string,
  content: string,
): Promise<void> {
  validateSkillNameLike(skillName);
  const safePath = normalizeRelativePath(relativePath);

  const root = await navigator.storage.getDirectory();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT, { create: true });
  const skillDir = await skillsDir.getDirectoryHandle(skillName, { create: true });

  const parts = safePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Invalid file path');

  let dir = skillDir;
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }

  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

async function loadBuiltinSkills(): Promise<SkillRecord[]> {
  const entries = Object.entries(BUILTIN_SKILL_BODIES);
  const records: SkillRecord[] = [];

  for (const [path, markdown] of entries) {
    const skillName = extractBuiltinSkillName(path);
    if (!skillName) continue;

    let parsed: ParsedSkill | null = null;
    const errors: SkillValidationError[] = [];

    try {
      parsed = parseSkillMarkdown(markdown);
      errors.push(...validateSkill(parsed.frontmatter, skillName));
    } catch (err) {
      errors.push({ code: 'parse_error', message: err instanceof Error ? err.message : String(err) });
    }

    records.push({
      name: parsed?.frontmatter.name || skillName,
      description: parsed?.frontmatter.description || '',
      source: 'builtin',
      location: `builtin://skills/${skillName}/`,
      rootPath: `./builtin-skills/${skillName}`,
      frontmatter: parsed?.frontmatter || ({ name: skillName, description: '' } as SkillFrontmatter),
      valid: errors.length === 0,
      errors,
    });
  }

  return records;
}

async function loadUserSkills(): Promise<SkillRecord[]> {
  const root = await navigator.storage.getDirectory();
  let skillsDir: FileSystemDirectoryHandle;
  try {
    skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT);
  } catch {
    return [];
  }

  const records: SkillRecord[] = [];
  for await (const [name, handle] of skillsDir.entries()) {
    if (handle.kind !== 'directory') continue;

    const skillName = name;
    const errors: SkillValidationError[] = [];
    let frontmatter: SkillFrontmatter | null = null;

    try {
      const markdown = await readUserSkillFile(skillName, 'SKILL.md');
      const parsed = parseSkillMarkdown(markdown);
      frontmatter = parsed.frontmatter;
      errors.push(...validateSkill(parsed.frontmatter, skillName));
    } catch (err) {
      errors.push({ code: 'parse_error', message: err instanceof Error ? err.message : String(err) });
    }

    records.push({
      name: frontmatter?.name || skillName,
      description: frontmatter?.description || '',
      source: 'user',
      location: `opfs://skills/${skillName}/`,
      rootPath: `${OPFS_SKILLS_ROOT}/${skillName}`,
      frontmatter: frontmatter || ({ name: skillName, description: '' } as SkillFrontmatter),
      valid: errors.length === 0,
      errors,
    });
  }

  return records;
}

function readBuiltinSkillMarkdown(skillName: string): string {
  const key = `./builtin-skills/${skillName}/SKILL.md`;
  const content = BUILTIN_SKILL_BODIES[key];
  if (typeof content !== 'string') {
    throw new Error(`Built-in SKILL.md not found for ${skillName}`);
  }
  return content;
}

function readBuiltinSkillFile(skillName: string, relativePath: string): string {
  const key = `./builtin-skills/${skillName}/${relativePath}`;
  const content = BUILTIN_SKILL_FILES[key];
  if (typeof content !== 'string') {
    throw new Error(`Built-in skill resource not found: ${relativePath}`);
  }
  return content;
}

function extractBuiltinSkillName(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const match = normalized.match(/^\.\/builtin-skills\/([^/]+)\/SKILL\.md$/);
  return match ? match[1] : null;
}

function parseSkillMarkdown(markdown: string): ParsedSkill {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const fmMatch = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }

  const frontmatterRaw = fmMatch[1];
  const body = normalized.slice(fmMatch[0].length);
  const frontmatter = parseFrontmatter(frontmatterRaw);
  return { frontmatter, body };
}

function parseFrontmatter(text: string): SkillFrontmatter {
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i++;

    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    const key = keyMatch[1];
    const rawValue = keyMatch[2];

    if (key === 'metadata') {
      const metadata: Record<string, string> = {};
      while (i < lines.length) {
        const nested = lines[i];
        if (!nested.startsWith('  ')) break;
        i++;
        if (!nested.trim()) continue;
        const nestedMatch = nested.match(/^\s{2}([^:]+):\s*(.*)$/);
        if (!nestedMatch) {
          throw new Error(`Invalid metadata entry: ${nested}`);
        }
        metadata[nestedMatch[1].trim()] = stripQuotes(nestedMatch[2].trim());
      }
      out.metadata = metadata;
      continue;
    }

    out[key] = stripQuotes(rawValue.trim());
  }

  return out as unknown as SkillFrontmatter;
}

function validateSkill(frontmatter: SkillFrontmatter, directoryName: string): SkillValidationError[] {
  const errors: SkillValidationError[] = [];

  const name = (frontmatter.name || '').trim();
  const description = (frontmatter.description || '').trim();

  if (!name) {
    errors.push({ code: 'name_required', message: 'name is required' });
  } else {
    if (name.length < 1 || name.length > 64) {
      errors.push({ code: 'name_length', message: 'name must be 1-64 characters' });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push({ code: 'name_format', message: 'name must be lowercase alphanumeric and hyphens' });
    }
    if (name !== directoryName) {
      errors.push({ code: 'name_directory_mismatch', message: 'name must match skill directory name' });
    }
  }

  if (!description) {
    errors.push({ code: 'description_required', message: 'description is required' });
  } else if (description.length > 1024) {
    errors.push({ code: 'description_length', message: 'description must be 1-1024 characters' });
  }

  if (frontmatter.compatibility && frontmatter.compatibility.length > 500) {
    errors.push({ code: 'compatibility_length', message: 'compatibility must be <= 500 characters' });
  }

  if (frontmatter.metadata) {
    for (const [k, v] of Object.entries(frontmatter.metadata)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        errors.push({ code: 'metadata_type', message: 'metadata must be string:string map' });
        break;
      }
    }
  }

  return errors;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/')) {
    throw new Error('Path must be a relative path within the skill directory');
  }

  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error('Path traversal is not allowed');
    }
  }

  return parts.join('/');
}

async function readUserSkillFile(skillName: string, relativePath: string): Promise<string> {
  validateSkillNameLike(skillName);
  const safePath = normalizeRelativePath(relativePath);

  const root = await navigator.storage.getDirectory();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT);
  const skillDir = await skillsDir.getDirectoryHandle(skillName);

  const parts = safePath.split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('Invalid file path');

  let dir = skillDir;
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment);
  }

  const file = await dir.getFileHandle(filename);
  return (await file.getFile()).text();
}

function validateSkillNameLike(skillName: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error('Invalid skill name format');
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
