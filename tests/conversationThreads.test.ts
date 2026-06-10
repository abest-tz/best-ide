import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/types';
import { ConversationThreadStore, type ThreadStorage } from '../src/extension/conversationThreads';

class MemoryStorage implements ThreadStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

function fixedClock(...isoTimes: string[]): () => Date {
  if (isoTimes.length === 0) {
    throw new Error('fixedClock requires at least one timestamp');
  }
  let index = 0;
  const fallback = isoTimes[isoTimes.length - 1];
  return () => {
    const value = isoTimes[Math.min(index, isoTimes.length - 1)] ?? fallback;
    index += 1;
    return new Date(value!);
  };
}

function fixedIds(...ids: string[]): () => string {
  if (ids.length === 0) {
    throw new Error('fixedIds requires at least one id');
  }
  let index = 0;
  const fallback = ids[ids.length - 1];
  return () => {
    const value = ids[Math.min(index, ids.length - 1)] ?? fallback;
    index += 1;
    return value!;
  };
}

describe('ConversationThreadStore', () => {
  it('creates a default thread when storage is empty', () => {
    const store = new ConversationThreadStore(
      new MemoryStorage(),
      fixedClock('2026-01-01T00:00:00.000Z'),
      fixedIds('thread-1')
    );

    const active = store.getActiveThread();
    expect(active.id).toBe('thread-1');
    expect(active.title).toBe('New chat');
    expect(active.transcript).toEqual([]);
    expect(store.listThreads()).toHaveLength(1);
  });

  it('records turns and titles thread from first user prompt', async () => {
    const store = new ConversationThreadStore(
      new MemoryStorage(),
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
      fixedIds('thread-1')
    );
    const active = store.getActiveThread();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'expanded user prompt' },
      { role: 'assistant', content: 'Sure, I can do that.' },
    ];

    await store.recordTurn(active.id, {
      userText: 'Implement thread persistence for this workspace',
      assistantTexts: ['Sure, I can do that.'],
      messages,
    });

    const updated = store.getActiveThread();
    expect(updated.title).toBe('Implement thread persistence for this workspace');
    expect(updated.transcript).toEqual([
      { kind: 'user', text: 'Implement thread persistence for this workspace' },
      { kind: 'assistant', text: 'Sure, I can do that.' },
    ]);
    expect(updated.messages).toEqual(messages);
  });

  it('can create and search multiple threads', async () => {
    const store = new ConversationThreadStore(
      new MemoryStorage(),
      fixedClock(
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:01:00.000Z',
        '2026-01-01T00:02:00.000Z',
        '2026-01-01T00:03:00.000Z'
      ),
      fixedIds('thread-1', 'thread-2')
    );

    await store.recordTurn(store.getActiveThread().id, {
      userText: 'Fix semantic search indexing',
      assistantTexts: ['Done'],
      messages: [{ role: 'system', content: 'sys' }],
    });

    const second = await store.createThread();
    await store.recordTurn(second.id, {
      userText: 'Add inline completion provider',
      assistantTexts: ['In progress'],
      messages: [{ role: 'system', content: 'sys' }],
    });

    const semanticResults = store.searchThreads('semantic search');
    expect(semanticResults).toHaveLength(1);
    expect(semanticResults[0]?.id).toBe('thread-1');

    const completionResults = store.searchThreads('inline completion');
    expect(completionResults).toHaveLength(1);
    expect(completionResults[0]?.id).toBe('thread-2');
  });

  it('exports thread transcript to markdown and json', async () => {
    const store = new ConversationThreadStore(
      new MemoryStorage(),
      fixedClock('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
      fixedIds('thread-1')
    );
    const threadId = store.getActiveThread().id;

    await store.recordTurn(threadId, {
      userText: 'Export this thread',
      assistantTexts: ['Exported.'],
      messages: [{ role: 'system', content: 'sys' }],
    });

    const markdown = store.exportThreadAsMarkdown(threadId);
    expect(markdown).toContain('# Export this thread');
    expect(markdown).toContain('## Conversation');
    expect(markdown).toContain('### User');

    const json = store.exportThreadAsJson(threadId);
    expect(json).toContain('"id": "thread-1"');
    expect(json).toContain('"kind": "assistant"');
  });
});
