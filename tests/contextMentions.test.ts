import { describe, expect, it } from 'vitest';
import { parseContextMentions } from '../src/extension/contextMentions';

describe('parseContextMentions', () => {
  it('extracts file, folder, and symbol mentions', () => {
    const parsed = parseContextMentions(
      'Review @file:src/extension/panel.ts @folder:src/extension @symbol:ChatViewProvider @skill:refactor now'
    );

    expect(parsed.malformedMentions).toEqual([]);
    expect(parsed.promptWithoutMentions).toBe('Review now');
    expect(parsed.mentions).toEqual([
      {
        kind: 'file',
        raw: '@file:src/extension/panel.ts',
        path: 'src/extension/panel.ts',
      },
      {
        kind: 'folder',
        raw: '@folder:src/extension',
        path: 'src/extension',
      },
      {
        kind: 'symbol',
        raw: '@symbol:ChatViewProvider',
        query: 'ChatViewProvider',
      },
      {
        kind: 'skill',
        raw: '@skill:refactor',
        name: 'refactor',
      },
    ]);
  });

  it('parses file line ranges', () => {
    const parsed = parseContextMentions('Use @file:src/core/tools.ts:20-40 for this fix');

    expect(parsed.malformedMentions).toEqual([]);
    expect(parsed.promptWithoutMentions).toBe('Use for this fix');
    expect(parsed.mentions).toEqual([
      {
        kind: 'file',
        raw: '@file:src/core/tools.ts:20-40',
        path: 'src/core/tools.ts',
        lineStart: 20,
        lineEnd: 40,
      },
    ]);
  });

  it('parses autocomplete-friendly file and folder paths', () => {
    const parsed = parseContextMentions(
      'Inspect @file:src/extension/ and @folder:src/extension/ with @skill:review'
    );

    expect(parsed.malformedMentions).toEqual([]);
    expect(parsed.promptWithoutMentions).toBe('Inspect and with');
    expect(parsed.mentions).toEqual([
      {
        kind: 'file',
        raw: '@file:src/extension/',
        path: 'src/extension/',
      },
      {
        kind: 'folder',
        raw: '@folder:src/extension/',
        path: 'src/extension/',
      },
      {
        kind: 'skill',
        raw: '@skill:review',
        name: 'review',
      },
    ]);
  });

  it('reports malformed mentions', () => {
    const parsed = parseContextMentions('Check @file:src/a.ts:30-10 and @folder: @skill: then continue');

    expect(parsed.mentions).toEqual([]);
    expect(parsed.malformedMentions).toEqual(['@file:src/a.ts:30-10', '@folder:', '@skill:']);
    expect(parsed.promptWithoutMentions).toBe('Check and then continue');
  });

  it('keeps unknown @ tokens in the prompt', () => {
    const parsed = parseContextMentions('Use @unknown:thing and keep it');

    expect(parsed.mentions).toEqual([]);
    expect(parsed.malformedMentions).toEqual([]);
    expect(parsed.promptWithoutMentions).toBe('Use @unknown:thing and keep it');
  });
});
