import { describe, expect, it } from 'vitest';
import {
  applyInlineEditToContent,
  buildInlineEditMessages,
  normalizeInlineEditResponse,
} from '../src/extension/inlineEdit';

describe('buildInlineEditMessages', () => {
  it('builds system and user messages with selection context', () => {
    const messages = buildInlineEditMessages({
      filePath: 'src/app.ts',
      languageId: 'typescript',
      instruction: 'Rename the variable to totalCount.',
      selection: 'const count = items.length;',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('File path: src/app.ts');
    expect(messages[1]?.content).toContain('Instruction:');
    expect(messages[1]?.content).toContain('const count = items.length;');
  });

  it('rejects empty instructions', () => {
    expect(() =>
      buildInlineEditMessages({
        filePath: 'src/app.ts',
        languageId: 'typescript',
        instruction: '   ',
        selection: 'const x = 1;',
      })
    ).toThrow(/instruction/i);
  });
});

describe('normalizeInlineEditResponse', () => {
  it('strips markdown code fences when present', () => {
    const normalized = normalizeInlineEditResponse('```ts\nconst totalCount = items.length;\n```');
    expect(normalized).toBe('const totalCount = items.length;');
  });

  it('falls back to trimming blank lines for plain text responses', () => {
    const normalized = normalizeInlineEditResponse('\n\nconst totalCount = items.length;\n\n');
    expect(normalized).toBe('const totalCount = items.length;');
  });
});

describe('applyInlineEditToContent', () => {
  it('replaces only the selected range', () => {
    const updated = applyInlineEditToContent(
      'function sum(a, b) {\n  return a + b;\n}\n',
      { startOffset: 30, endOffset: 35 },
      'a - b'
    );
    expect(updated).toBe('function sum(a, b) {\n  return a - b;\n}\n');
  });

  it('validates the replacement range', () => {
    expect(() =>
      applyInlineEditToContent('abc', { startOffset: 3, endOffset: 2 }, 'x')
    ).toThrow(/invalid inline edit range/i);
  });
});
