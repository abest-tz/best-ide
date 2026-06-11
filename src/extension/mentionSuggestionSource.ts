import type { MentionSuggestionCandidate, MentionSuggestionSource } from './mentionSuggestions';
import { listSkillNames } from './skills';

export interface MentionSuggestionHost {
  listDir(relativePath: string): Promise<Array<{ name: string; type: 'file' | 'dir' }>>;
  getSymbols(query?: string): Promise<string>;
}

interface PathQueryParts {
  directory: string;
  namePrefix: string;
}

function normalizePathQuery(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
}

function splitPathQuery(value: string): PathQueryParts {
  const normalized = normalizePathQuery(value);
  if (normalized === '') {
    return { directory: '.', namePrefix: '' };
  }
  if (normalized.endsWith('/')) {
    return { directory: normalized.replace(/\/+$/, '') || '.', namePrefix: '' };
  }
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex < 0) {
    return { directory: '.', namePrefix: normalized };
  }
  const directory = normalized.slice(0, slashIndex) || '.';
  const namePrefix = normalized.slice(slashIndex + 1);
  return { directory, namePrefix };
}

function pathPrefixRank(candidateName: string, prefix: string): number {
  if (prefix === '') {
    return 0;
  }
  const normalizedCandidate = candidateName.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  if (normalizedCandidate.startsWith(normalizedPrefix)) {
    return 0;
  }
  if (normalizedCandidate.includes(normalizedPrefix)) {
    return 1;
  }
  return 2;
}

async function suggestPaths(
  host: MentionSuggestionHost,
  query: string,
  limit: number,
  mode: 'file' | 'folder'
): Promise<MentionSuggestionCandidate[]> {
  const { directory, namePrefix } = splitPathQuery(query);
  let entries: Array<{ name: string; type: 'file' | 'dir' }>;
  try {
    entries = await host.listDir(directory);
  } catch {
    return [];
  }

  const scored = entries
    .filter((entry) => (mode === 'folder' ? entry.type === 'dir' : true))
    .map((entry, index) => {
      const rank = pathPrefixRank(entry.name, namePrefix);
      const joined = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      const value = entry.type === 'dir' ? `${joined}/` : joined;
      return {
        index,
        rank,
        candidate: {
          label: value,
          value,
          detail: entry.type === 'dir' ? 'folder' : 'file',
        },
      };
    })
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      if (a.candidate.detail !== b.candidate.detail) {
        return a.candidate.detail === 'folder' ? -1 : 1;
      }
      return a.index - b.index;
    });

  return scored.slice(0, limit).map((entry) => entry.candidate);
}

function parseWorkspaceSymbol(line: string): MentionSuggestionCandidate | undefined {
  if (line.trim() === '' || line.startsWith('(no symbols)')) {
    return undefined;
  }
  const match = line.match(/^(.+?):(\d+):([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }
  const path = match[1];
  const lineNumber = match[2];
  const symbolKind = match[3];
  const symbolName = match[4];
  if (!path || !lineNumber || !symbolKind || !symbolName) {
    return undefined;
  }
  const cleanedName = symbolName.trim();
  if (cleanedName === '') {
    return undefined;
  }
  return {
    label: cleanedName,
    value: cleanedName,
    detail: `${symbolKind.trim()} • ${path}:${lineNumber}`,
  };
}

async function suggestSymbols(
  host: MentionSuggestionHost,
  query: string,
  limit: number
): Promise<MentionSuggestionCandidate[]> {
  const raw = await host.getSymbols(query);
  const seen = new Set<string>();
  const out: MentionSuggestionCandidate[] = [];
  for (const line of raw.split('\n')) {
    if (out.length >= limit) {
      break;
    }
    const parsed = parseWorkspaceSymbol(line);
    if (!parsed) {
      continue;
    }
    const key = `${parsed.value}\n${parsed.detail ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

async function suggestSkills(
  host: MentionSuggestionHost,
  query: string,
  limit: number
): Promise<MentionSuggestionCandidate[]> {
  const names = await listSkillNames((path) => host.listDir(path));
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = names
    .filter((name) =>
      normalizedQuery === '' ? true : name.toLowerCase().startsWith(normalizedQuery) || name.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, limit);
  return filtered.map((name) => ({ label: name, value: name }));
}

export function createMentionSuggestionSource(host: MentionSuggestionHost): MentionSuggestionSource {
  return {
    suggestFiles: async (query, limit) => suggestPaths(host, query, limit, 'file'),
    suggestFolders: async (query, limit) => suggestPaths(host, query, limit, 'folder'),
    suggestSymbols: async (query, limit) => suggestSymbols(host, query, limit),
    suggestSkills: async (query, limit) => suggestSkills(host, query, limit),
  };
}
