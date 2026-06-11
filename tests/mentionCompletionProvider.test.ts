import { describe, expect, it } from 'vitest';
import { createMentionSuggestionSource } from '../src/extension/mentionSuggestionSource';
import { resolveMentionSuggestions } from '../src/extension/mentionSuggestions';

function createHost() {
  return {
    async listDir(path: string): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
      if (path === '.') {
        return [
          { name: 'src', type: 'dir' },
          { name: '.bestide', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ];
      }
      if (path === 'src') {
        return [
          { name: 'extension', type: 'dir' },
          { name: 'core', type: 'dir' },
        ];
      }
      if (path === 'src/extension') {
        return [
          { name: 'panel.ts', type: 'file' },
          { name: 'contextMentions.ts', type: 'file' },
        ];
      }
      if (path === '.bestide/skills') {
        return [
          { name: 'review.md', type: 'file' },
          { name: 'refactor', type: 'dir' },
        ];
      }
      if (path === '.bestide/skills/refactor') {
        return [{ name: 'SKILL.md', type: 'file' }];
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async getSymbols(query = ''): Promise<string> {
      const rows = [
        'src/extension/panel.ts:175:Class:ChatViewProvider',
        'src/extension/contextMentions.ts:125:Function:parseContextMentions',
      ];
      const needle = query.toLowerCase();
      return rows.filter((row) => row.toLowerCase().includes(needle)).join('\n') || '(no symbols)';
    },
  };
}

describe('mention completion data integration', () => {
  it('suggests file mentions with workspace paths', async () => {
    const source = createMentionSuggestionSource(createHost());
    const result = await resolveMentionSuggestions(
      {
        text: '@file:src/ext',
        cursor: '@file:src/ext'.length,
      },
      source
    );

    expect(result.active).toBe(true);
    expect(result.kind).toBe('file');
    expect(result.items[0]?.insertText).toBe('@file:src/extension/');
  });

  it('suggests symbols and skill names', async () => {
    const source = createMentionSuggestionSource(createHost());
    const symbolResult = await resolveMentionSuggestions(
      {
        text: '@symbol:Chat',
        cursor: '@symbol:Chat'.length,
      },
      source
    );
    const skillResult = await resolveMentionSuggestions(
      {
        text: '@skill:r',
        cursor: '@skill:r'.length,
      },
      source
    );

    expect(symbolResult.items[0]?.insertText).toBe('@symbol:ChatViewProvider');
    expect(skillResult.items.map((item) => item.insertText)).toEqual([
      '@skill:refactor',
      '@skill:review',
    ]);
  });
});
