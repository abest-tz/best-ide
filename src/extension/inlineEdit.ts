import type { ChatMessage } from '../core/types';

export interface InlineEditPromptInput {
  filePath: string;
  languageId: string;
  instruction: string;
  selection: string;
}

export interface InlineEditOffsets {
  startOffset: number;
  endOffset: number;
}

const INLINE_EDIT_SYSTEM_PROMPT =
  'You are an inline code editing assistant. Rewrite only the selected code according to the instruction. Return only the replacement code for the selected region, with no markdown fences and no explanation.';

function trimOuterBlankLines(text: string): string {
  return text.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

export function buildInlineEditMessages(input: InlineEditPromptInput): ChatMessage[] {
  const instruction = input.instruction.trim();
  if (instruction === '') {
    throw new Error('inline edit instruction cannot be empty');
  }
  const language = input.languageId.trim() || 'text';
  return [
    { role: 'system', content: INLINE_EDIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `File path: ${input.filePath}
Language: ${language}

Instruction:
${instruction}

Selected code:
\`\`\`${language}
${input.selection}
\`\`\`

Return only the updated selected code.`,
    },
  ];
}

export function normalizeInlineEditResponse(raw: string): string {
  const fenced = raw.match(/```(?:[\w.+-]*)\s*\n([\s\S]*?)\n```/);
  if (fenced?.[1] !== undefined) {
    return trimOuterBlankLines(fenced[1]);
  }
  return trimOuterBlankLines(raw);
}

export function applyInlineEditToContent(
  content: string,
  offsets: InlineEditOffsets,
  replacement: string
): string {
  if (offsets.startOffset < 0 || offsets.endOffset < offsets.startOffset || offsets.endOffset > content.length) {
    throw new Error('invalid inline edit range');
  }
  return `${content.slice(0, offsets.startOffset)}${replacement}${content.slice(offsets.endOffset)}`;
}
