export interface ContextFileMention {
  kind: 'file';
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ContextFolderMention {
  kind: 'folder';
  raw: string;
  path: string;
}

export interface ContextSymbolMention {
  kind: 'symbol';
  raw: string;
  query: string;
}

export interface ContextSkillMention {
  kind: 'skill';
  raw: string;
  name: string;
}

export type ContextMention =
  | ContextFileMention
  | ContextFolderMention
  | ContextSymbolMention
  | ContextSkillMention;

export interface ParsedContextMentions {
  mentions: ContextMention[];
  malformedMentions: string[];
  promptWithoutMentions: string;
}

interface ParsedMentionToken {
  mention?: ContextMention;
  malformed?: string;
  consumed: boolean;
}

function parseFileMention(raw: string, value: string): ParsedMentionToken {
  if (value === '') {
    return { malformed: raw, consumed: true };
  }

  const rangeMatch = value.match(/^(.*):(\d+)-(\d+)$/);
  if (!rangeMatch) {
    return {
      mention: {
        kind: 'file',
        raw,
        path: value,
      },
      consumed: true,
    };
  }

  const filePath = rangeMatch[1] ?? '';
  const lineStart = Number.parseInt(rangeMatch[2] ?? '', 10);
  const lineEnd = Number.parseInt(rangeMatch[3] ?? '', 10);
  if (filePath === '' || !Number.isFinite(lineStart) || !Number.isFinite(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    return { malformed: raw, consumed: true };
  }
  return {
    mention: {
      kind: 'file',
      raw,
      path: filePath,
      lineStart,
      lineEnd,
    },
    consumed: true,
  };
}

function parseMentionToken(token: string): ParsedMentionToken {
  if (!token.startsWith('@')) {
    return { consumed: false };
  }

  const body = token.slice(1);
  if (body.startsWith('file:')) {
    return parseFileMention(token, body.slice('file:'.length));
  }

  if (body.startsWith('folder:')) {
    const folderPath = body.slice('folder:'.length);
    return folderPath === ''
      ? { malformed: token, consumed: true }
      : { mention: { kind: 'folder', raw: token, path: folderPath }, consumed: true };
  }

  if (body.startsWith('symbol:')) {
    const query = body.slice('symbol:'.length);
    return query === ''
      ? { malformed: token, consumed: true }
      : { mention: { kind: 'symbol', raw: token, query }, consumed: true };
  }

  if (body.startsWith('skill:')) {
    const name = body.slice('skill:'.length);
    return name === ''
      ? { malformed: token, consumed: true }
      : { mention: { kind: 'skill', raw: token, name }, consumed: true };
  }

  return { consumed: false };
}

function stripTrailingPunctuation(token: string): { core: string; trailing: string } {
  const match = token.match(/^(.+?)([.,;!?]+)?$/);
  if (!match) {
    return { core: token, trailing: '' };
  }
  return {
    core: match[1] ?? token,
    trailing: match[2] ?? '',
  };
}

export function parseContextMentions(prompt: string): ParsedContextMentions {
  const mentions: ContextMention[] = [];
  const malformedMentions: string[] = [];
  const keptTokens: string[] = [];

  for (const token of prompt.split(/\s+/).filter((part) => part.length > 0)) {
    const { core, trailing } = stripTrailingPunctuation(token);
    const parsed = parseMentionToken(core);
    if (!parsed.consumed) {
      keptTokens.push(token);
      continue;
    }
    if (parsed.mention) {
      mentions.push(parsed.mention);
    } else if (parsed.malformed) {
      malformedMentions.push(parsed.malformed);
    }
    if (trailing) {
      keptTokens.push(trailing);
    }
  }

  return {
    mentions,
    malformedMentions,
    promptWithoutMentions: keptTokens.join(' ').trim(),
  };
}
