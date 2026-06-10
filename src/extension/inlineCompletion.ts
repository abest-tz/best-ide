import type { ChatMessage } from '../core/types';

const INLINE_COMPLETION_SYSTEM_PROMPT =
  'You are an inline code completion assistant. Continue the code at the cursor. Return only the text to insert at the cursor, with no markdown fences and no explanation.';
const INLINE_COMPLETION_PREFIX_MAX_CHARS = 4_000;
const INLINE_COMPLETION_SUFFIX_MAX_CHARS = 1_000;
const INLINE_COMPLETION_MAX_CHARS = 600;

export interface InlineCompletionPromptInput {
  filePath: string;
  languageId: string;
  prefix: string;
  suffix: string;
}

export interface InlineCompletionContext {
  prefix: string;
  suffix: string;
}

function trimOuterBlankLines(text: string): string {
  return text.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

export function buildInlineCompletionMessages(input: InlineCompletionPromptInput): ChatMessage[] {
  const language = input.languageId.trim() || 'text';
  return [
    { role: 'system', content: INLINE_COMPLETION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `File path: ${input.filePath}
Language: ${language}

Code before cursor:
\`\`\`${language}
${input.prefix}
\`\`\`

Code after cursor:
\`\`\`${language}
${input.suffix}
\`\`\`

Return only the continuation text to insert at the cursor.`,
    },
  ];
}

export function buildInlineCompletionContext(
  documentText: string,
  cursorOffset: number
): InlineCompletionContext {
  if (cursorOffset < 0 || cursorOffset > documentText.length) {
    throw new Error('invalid inline completion cursor offset');
  }
  return {
    prefix: documentText.slice(Math.max(0, cursorOffset - INLINE_COMPLETION_PREFIX_MAX_CHARS), cursorOffset),
    suffix: documentText.slice(
      cursorOffset,
      Math.min(documentText.length, cursorOffset + INLINE_COMPLETION_SUFFIX_MAX_CHARS)
    ),
  };
}

export function normalizeInlineCompletionResponse(raw: string): string {
  const fenced = raw.match(/```(?:[\w.+-]*)\s*\n([\s\S]*?)\n```/);
  if (fenced?.[1] !== undefined) {
    return trimOuterBlankLines(fenced[1]);
  }
  return trimOuterBlankLines(raw);
}

export function trimTypedPrefixOverlap(completion: string, typedPrefix: string): string {
  if (completion === '' || typedPrefix === '') {
    return completion;
  }
  const maxOverlap = Math.min(completion.length, typedPrefix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (typedPrefix.endsWith(completion.slice(0, overlap))) {
      return completion.slice(overlap);
    }
  }
  return completion;
}

export function trimSuffixOverlap(completion: string, suffix: string): string {
  if (completion === '' || suffix === '') {
    return completion;
  }
  const maxOverlap = Math.min(completion.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (completion.endsWith(suffix.slice(0, overlap))) {
      return completion.slice(0, completion.length - overlap);
    }
  }
  return completion;
}

export function finalizeInlineCompletion(raw: string, typedPrefix: string, suffix: string): string {
  const normalized = normalizeInlineCompletionResponse(raw);
  const withoutTypedPrefix = trimTypedPrefixOverlap(normalized, typedPrefix);
  const withoutSuffixOverlap = trimSuffixOverlap(withoutTypedPrefix, suffix);
  return withoutSuffixOverlap.slice(0, INLINE_COMPLETION_MAX_CHARS);
}
