import { describe, expect, it } from 'vitest';
import { PendingChangeStore } from '../src/extension/pendingChanges';
import type { ThreadStorage } from '../src/extension/conversationThreads';

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

describe('PendingChangeStore', () => {
  it('returns an empty list when storage is empty', () => {
    const store = new PendingChangeStore(new MemoryStorage());
    expect(store.list()).toEqual([]);
  });

  it('round-trips pending changes', async () => {
    const storage = new MemoryStorage();
    const store = new PendingChangeStore(storage);
    await store.save([
      {
        path: 'src/a.ts',
        turnId: 2,
        proposedContent: 'new',
        previousContent: 'old',
        targetFsPath: '/tmp/workspace/src/a.ts',
      },
    ]);

    const restored = new PendingChangeStore(storage).list();
    expect(restored).toEqual([
      {
        path: 'src/a.ts',
        turnId: 2,
        proposedContent: 'new',
        previousContent: 'old',
        targetFsPath: '/tmp/workspace/src/a.ts',
      },
    ]);
  });

  it('drops malformed entries', async () => {
    const storage = new MemoryStorage();
    await storage.update('bestIde.pendingChanges.v1', [
      { path: 'ok.ts', turnId: 1, proposedContent: 'x', targetFsPath: '/tmp/ok.ts' },
      { path: 123 },
      null,
    ]);
    const store = new PendingChangeStore(storage);
    expect(store.list()).toEqual([
      {
        path: 'ok.ts',
        turnId: 1,
        proposedContent: 'x',
        previousContent: undefined,
        targetFsPath: '/tmp/ok.ts',
      },
    ]);
  });

  it('clears stored changes', async () => {
    const storage = new MemoryStorage();
    const store = new PendingChangeStore(storage);
    await store.save([
      {
        path: 'a.ts',
        turnId: 1,
        proposedContent: 'x',
        previousContent: undefined,
        targetFsPath: '/tmp/a.ts',
      },
    ]);
    await store.clear();
    expect(store.list()).toEqual([]);
  });
});
