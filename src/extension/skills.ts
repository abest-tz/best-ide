const SKILLS_DIRECTORY = '.bestide/skills';
const SKILL_MARKDOWN_FILENAME = 'SKILL.md';

export interface ResolvedSkillFile {
  name: string;
  path: string;
  content: string;
}

export interface SkillDirectoryEntry {
  name: string;
  type: 'file' | 'dir';
}

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(no such file|enoent|not found)/i.test(message);
}

function normalizeSkillName(rawName: string): string {
  const normalized = rawName.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized === '') {
    throw new Error('skill name cannot be empty');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`invalid skill name "${rawName}"`);
  }

  return segments.join('/');
}

export function buildSkillCandidatePaths(rawName: string): string[] {
  const name = normalizeSkillName(rawName);
  if (name.toLowerCase().endsWith('.md')) {
    return [`${SKILLS_DIRECTORY}/${name}`];
  }
  return [`${SKILLS_DIRECTORY}/${name}.md`, `${SKILLS_DIRECTORY}/${name}/${SKILL_MARKDOWN_FILENAME}`];
}

export async function listSkillNames(
  listDir: (path: string) => Promise<readonly SkillDirectoryEntry[]>
): Promise<string[]> {
  let rootEntries: readonly SkillDirectoryEntry[];
  try {
    rootEntries = await listDir(SKILLS_DIRECTORY);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const names = new Set<string>();
  for (const entry of rootEntries) {
    if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')) {
      const basename = entry.name.slice(0, -3).trim();
      if (basename !== '') {
        names.add(basename);
      }
      continue;
    }
    if (entry.type !== 'dir') {
      continue;
    }
    try {
      const childEntries = await listDir(`${SKILLS_DIRECTORY}/${entry.name}`);
      const hasSkillMarkdown = childEntries.some(
        (child) => child.type === 'file' && child.name.toLowerCase() === SKILL_MARKDOWN_FILENAME.toLowerCase()
      );
      if (hasSkillMarkdown) {
        names.add(entry.name);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function resolveSkillFile(
  rawName: string,
  readFile: (path: string) => Promise<string>
): Promise<ResolvedSkillFile> {
  const name = normalizeSkillName(rawName);
  const candidates = buildSkillCandidatePaths(name);

  for (const candidate of candidates) {
    try {
      const content = (await readFile(candidate)).trim();
      if (content === '') {
        throw new Error(`skill "${name}" is empty (${candidate})`);
      }
      return { name, path: candidate, content };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `skill "${name}" was not found under ${SKILLS_DIRECTORY} (checked: ${candidates.join(', ')})`
  );
}
