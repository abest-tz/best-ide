import { describe, expect, it, vi } from 'vitest';
import {
  detectActiveMentionQuery,
  resolveMentionSuggestions,
  type MentionSuggestionSource,
} from '../src/extension/mentionSuggestions';

function createSource(overrides: Partial<MentionSuggestionSource> = {}): MentionSuggestionSource {
  return {
    suggestFiles: async () => [],
    suggestFolders: async () => [],
    suggestSymbols: async () => [],
    suggestSkills: async () => [],
    ...overrides,
  };
}

describe('detectActiveMentionQuery', () => {
  it('detects kind bootstrap queries', () => {
    const text = 'Review @fo';
    const query = detectActiveMentionQuery(text, text.length);
    expect(query).toEqual({
      rangeStart: 7,
      rangeEnd: 10,
      query: '',
      kindQuery: 'fo',
    });
  });

  it('detects typed mention kind and query', () => {
    const text = 'Use @file:src/ext';
    const query = detectActiveMentionQuery(text, text.length);
    expect(query).toEqual({
      rangeStart: 4,
      rangeEnd: 17,
      kind: 'file',
      query: 'src/ext',
      kindQuery: '',
    });
  });

  it('stops suggestions once the cursor leaves the token', () => {
    const text = '@file:src/app.ts ';
    expect(detectActiveMentionQuery(text, text.length)).toBeUndefined();
  });
});

describe('resolveMentionSuggestions', () => {
  it('returns bootstrap kind suggestions for partial kind names', async () => {
    const result = await resolveMentionSuggestions(
      {
        text: '@sy',
        cursor: 3,
      },
      createSource()
    );
    expect(result.active).toBe(true);
    expect(result.items).toEqual([
      {
        kind: 'kind',
        label: '@symbol:',
        insertText: '@symbol:',
        detail: 'Reference symbols by name',
      },
    ]);
  });

  it('maps file candidates to mention insert text', async () => {
    const suggestFiles = vi.fn(async () => [
      { label: 'src/extension/panel.ts', value: 'src/extension/panel.ts', detail: 'file' },
      { label: 'src/extension/', value: 'src/extension/', detail: 'folder' },
    ]);
    const result = await resolveMentionSuggestions(
      {
        text: 'Inspect @file:src/ext',
        cursor: 'Inspect @file:src/ext'.length,
      },
      createSource({ suggestFiles })
    );

    expect(suggestFiles).toHaveBeenCalledWith('src/ext', 24);
    expect(result.active).toBe(true);
    expect(result.kind).toBe('file');
    expect(result.rangeStart).toBe(8);
    expect(result.rangeEnd).toBe(21);
    expect(result.items[0]).toEqual({
      kind: 'file',
      label: 'src/extension/panel.ts',
      insertText: '@file:src/extension/panel.ts',
      detail: 'file',
    });
  });

  it('returns inactive results when no mention is active', async () => {
    const result = await resolveMentionSuggestions(
      {
        text: 'No mentions here',
        cursor: 3,
      },
      createSource()
    );

    expect(result).toEqual({
      active: false,
      rangeStart: 3,
      rangeEnd: 3,
      items: [],
    });
  });
});
