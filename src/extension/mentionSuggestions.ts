import type { MentionSuggestionItem } from '../shared/protocol';

const DEFAULT_SUGGESTION_LIMIT = 12;

const KIND_ITEMS: ReadonlyArray<{
  kind: MentionQueryKind;
  detail: string;
}> = [
  { kind: 'file', detail: 'Reference a file path' },
  { kind: 'folder', detail: 'Reference a folder path' },
  { kind: 'symbol', detail: 'Reference symbols by name' },
  { kind: 'skill', detail: 'Reference a skill from .bestide/skills' },
];

export type MentionQueryKind = 'file' | 'folder' | 'symbol' | 'skill';

export interface MentionSuggestionCandidate {
  label: string;
  value: string;
  detail?: string;
}

export interface MentionSuggestionSource {
  suggestFiles(query: string, limit: number): Promise<MentionSuggestionCandidate[]>;
  suggestFolders(query: string, limit: number): Promise<MentionSuggestionCandidate[]>;
  suggestSymbols(query: string, limit: number): Promise<MentionSuggestionCandidate[]>;
  suggestSkills(query: string, limit: number): Promise<MentionSuggestionCandidate[]>;
}

export interface MentionSuggestionRequestInput {
  text: string;
  cursor: number;
  limit?: number;
}

export interface MentionSuggestionResponse {
  active: boolean;
  rangeStart: number;
  rangeEnd: number;
  kind?: MentionQueryKind;
  query?: string;
  items: MentionSuggestionItem[];
}

export interface ActiveMentionQuery {
  rangeStart: number;
  rangeEnd: number;
  kind?: MentionQueryKind;
  query: string;
  kindQuery: string;
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}

function isMentionKind(value: string): value is MentionQueryKind {
  return value === 'file' || value === 'folder' || value === 'symbol' || value === 'skill';
}

function filterAndPrioritize(
  items: ReadonlyArray<MentionSuggestionCandidate>,
  query: string,
  limit: number
): MentionSuggestionCandidate[] {
  if (items.length === 0) {
    return [];
  }
  const normalizedQuery = query.trim().toLowerCase();
  const prioritized = items
    .map((candidate, index) => {
      const normalizedLabel = candidate.label.toLowerCase();
      const normalizedValue = candidate.value.toLowerCase();
      const startsWith =
        normalizedQuery === '' ||
        normalizedLabel.startsWith(normalizedQuery) ||
        normalizedValue.startsWith(normalizedQuery);
      const contains =
        normalizedQuery === '' ||
        normalizedLabel.includes(normalizedQuery) ||
        normalizedValue.includes(normalizedQuery);
      const rank = startsWith ? 0 : contains ? 1 : 2;
      return { candidate, index, rank };
    })
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank));
  return prioritized.slice(0, limit).map((entry) => entry.candidate);
}

export function detectActiveMentionQuery(text: string, cursor: number): ActiveMentionQuery | undefined {
  if (cursor < 0 || cursor > text.length) {
    return undefined;
  }
  if (cursor < text.length && isWhitespace(text[cursor] ?? '')) {
    return undefined;
  }
  if (cursor > 0 && isWhitespace(text[cursor - 1] ?? '')) {
    return undefined;
  }

  let tokenStart = cursor;
  while (tokenStart > 0 && !isWhitespace(text[tokenStart - 1] ?? '')) {
    tokenStart -= 1;
  }

  const tokenPrefix = text.slice(tokenStart, cursor);
  if (!tokenPrefix.startsWith('@')) {
    return undefined;
  }

  const body = tokenPrefix.slice(1);
  const colonIndex = body.indexOf(':');
  if (colonIndex < 0) {
    return {
      rangeStart: tokenStart,
      rangeEnd: cursor,
      query: '',
      kindQuery: body.toLowerCase(),
    };
  }

  const rawKind = body.slice(0, colonIndex).toLowerCase();
  const query = body.slice(colonIndex + 1);
  if (isMentionKind(rawKind)) {
    return {
      rangeStart: tokenStart,
      rangeEnd: cursor,
      kind: rawKind,
      query,
      kindQuery: '',
    };
  }

  return {
    rangeStart: tokenStart,
    rangeEnd: cursor,
    query: '',
    kindQuery: rawKind,
  };
}

function toMentionItems(
  kind: MentionQueryKind,
  candidates: ReadonlyArray<MentionSuggestionCandidate>
): MentionSuggestionItem[] {
  return candidates.map((candidate) => ({
    kind,
    label: candidate.label,
    insertText: `@${kind}:${candidate.value}`,
    ...(candidate.detail ? { detail: candidate.detail } : {}),
  }));
}

function kindBootstrapItems(kindQuery: string, limit: number): MentionSuggestionItem[] {
  const normalizedQuery = kindQuery.trim().toLowerCase();
  const filtered = KIND_ITEMS.filter(({ kind }) =>
    normalizedQuery === '' ? true : kind.startsWith(normalizedQuery) || kind.includes(normalizedQuery)
  ).slice(0, limit);
  return filtered.map(({ kind, detail }) => ({
    kind: 'kind',
    label: `@${kind}:`,
    insertText: `@${kind}:`,
    detail,
  }));
}

export async function resolveMentionSuggestions(
  input: MentionSuggestionRequestInput,
  source: MentionSuggestionSource
): Promise<MentionSuggestionResponse> {
  const safeCursor = Math.max(0, Math.min(input.cursor, input.text.length));
  const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_SUGGESTION_LIMIT));
  const query = detectActiveMentionQuery(input.text, safeCursor);
  if (!query) {
    return {
      active: false,
      rangeStart: safeCursor,
      rangeEnd: safeCursor,
      items: [],
    };
  }

  if (!query.kind) {
    return {
      active: true,
      rangeStart: query.rangeStart,
      rangeEnd: query.rangeEnd,
      items: kindBootstrapItems(query.kindQuery, limit),
    };
  }

  let candidates: MentionSuggestionCandidate[] = [];
  if (query.kind === 'file') {
    candidates = filterAndPrioritize(await source.suggestFiles(query.query, limit * 2), query.query, limit);
  } else if (query.kind === 'folder') {
    candidates = filterAndPrioritize(await source.suggestFolders(query.query, limit * 2), query.query, limit);
  } else if (query.kind === 'symbol') {
    candidates = filterAndPrioritize(await source.suggestSymbols(query.query, limit * 2), query.query, limit);
  } else {
    candidates = filterAndPrioritize(await source.suggestSkills(query.query, limit * 2), query.query, limit);
  }

  return {
    active: true,
    rangeStart: query.rangeStart,
    rangeEnd: query.rangeEnd,
    kind: query.kind,
    query: query.query,
    items: toMentionItems(query.kind, candidates),
  };
}
