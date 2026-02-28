import { OPFS_SKILLS_ROOT } from './config.js';
import { getOpfsRoot } from './opfs.js';

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  const root = await getOpfsRoot();
  const skillsDir = await root.getDirectoryHandle(OPFS_SKILLS_ROOT, { create });
  return skillsDir.getDirectoryHandle(skillName, { create });
}
