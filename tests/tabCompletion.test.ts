import { describe, expect, it } from 'vitest';
import {
  buildInlineCompletionContext,
  buildInlineCompletionMessages,
  finalizeInlineCompletion,
  normalizeInlineCompletionResponse,
  trimSuffixOverlap,
  trimTypedPrefixOverlap,
} from '../src/extension/inlineCompletion';
import { detectActiveMentionQuery } from '../src/extension/mentionSuggestions';

describe('buildInlineCompletionMessages', () => {
  it('builds a completion prompt with file and cursor context', () => {
    const messages = buildInlineCompletionMessages({
      filePath: 'src/app.ts',
      languageId: 'typescript',
      prefix: 'const va',
      suffix: ' = items.length;',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('File path: src/app.ts');
    expect(messages[1]?.content).toContain('Code before cursor:');
    expect(messages[1]?.content).toContain('Code after cursor:');
  });
});

describe('buildInlineCompletionContext', () => {
  it('returns prefix and suffix around the cursor offset', () => {
    const context = buildInlineCompletionContext('hello world', 5);
    expect(context).toEqual({ prefix: 'hello', suffix: ' world' });
  });

  it('truncates prefix and suffix windows', () => {
    const prefix = 'a'.repeat(5_000);
    const suffix = 'b'.repeat(2_000);
    const context = buildInlineCompletionContext(`${prefix}${suffix}`, prefix.length);
    expect(context.prefix.length).toBe(4_000);
    expect(context.suffix.length).toBe(1_000);
    expect(context.prefix).toBe(prefix.slice(-4_000));
    expect(context.suffix).toBe(suffix.slice(0, 1_000));
  });

  it('rejects invalid cursor offsets', () => {
    expect(() => buildInlineCompletionContext('abc', -1)).toThrow(/offset/i);
    expect(() => buildInlineCompletionContext('abc', 4)).toThrow(/offset/i);
  });
});

describe('completion normalization', () => {
  it('strips code fences from model responses', () => {
    const normalized = normalizeInlineCompletionResponse('```ts\nreturn value;\n```');
    expect(normalized).toBe('return value;');
  });

  it('drops typed-prefix overlap from the completion', () => {
    expect(trimTypedPrefixOverlap('const value = 1;', 'const va')).toBe('lue = 1;');
  });

  it('drops suffix overlap from the completion', () => {
    expect(trimSuffixOverlap('value);', ');')).toBe('value');
  });
});

describe('finalizeInlineCompletion', () => {
  it('removes both typed-prefix and suffix overlap', () => {
    const text = finalizeInlineCompletion(
      '```ts\nconst value = items.length;\n```',
      'const va',
      ' = items.length;'
    );
    expect(text).toBe('lue');
  });

  it('clips excessively long completions', () => {
    const text = finalizeInlineCompletion('x'.repeat(700), '', '');
    expect(text.length).toBe(600);
  });
});

describe('mention coexistence guard', () => {
  it('detects active @ mention tokens', () => {
    const line = 'const prompt = @file:src/ext';
    const cursor = line.indexOf('@file:src/ext') + '@file:src/ext'.length;
    expect(detectActiveMentionQuery(line, cursor)).toEqual({
      rangeStart: line.indexOf('@file:src/ext'),
      rangeEnd: cursor,
      kind: 'file',
      query: 'src/ext',
      kindQuery: '',
    });
  });

  it('returns undefined when cursor is not inside a mention token', () => {
    expect(detectActiveMentionQuery('const value = 1', 'const'.length)).toBeUndefined();
  });
});
