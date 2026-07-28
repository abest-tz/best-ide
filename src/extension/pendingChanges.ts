import type { ThreadStorage } from './conversationThreads';

const STORAGE_KEY = 'bestIde.pendingChanges.v1';

export interface PersistedPendingChange {
  path: string;
  turnId: number;
  proposedContent: string;
  previousContent: string | undefined;
  targetFsPath: string;
}

export class PendingChangeStore {
  constructor(private readonly storage: ThreadStorage) {}

  list(): PersistedPendingChange[] {
    const raw = this.storage.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(normalizePersistedPendingChange)
      .filter((entry): entry is PersistedPendingChange => entry !== undefined);
  }

  async save(changes: readonly PersistedPendingChange[]): Promise<void> {
    await this.storage.update(
      STORAGE_KEY,
      changes.map((change) => ({
        path: change.path,
        turnId: change.turnId,
        proposedContent: change.proposedContent,
        previousContent: change.previousContent,
        targetFsPath: change.targetFsPath,
      }))
    );
  }

  async clear(): Promise<void> {
    await this.save([]);
  }
}

export function toPersistedPendingChange(change: {
  path: string;
  turnId: number;
  proposedContent: string;
  previousContent: string | undefined;
  targetUri: { fsPath: string };
}): PersistedPendingChange {
  return {
    path: change.path,
    turnId: change.turnId,
    proposedContent: change.proposedContent,
    previousContent: change.previousContent,
    targetFsPath: change.targetUri.fsPath,
  };
}

function normalizePersistedPendingChange(value: unknown): PersistedPendingChange | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['path'] !== 'string' ||
    typeof record['turnId'] !== 'number' ||
    !Number.isFinite(record['turnId']) ||
    typeof record['proposedContent'] !== 'string' ||
    typeof record['targetFsPath'] !== 'string'
  ) {
    return undefined;
  }
  const previousContent = record['previousContent'];
  if (previousContent !== undefined && typeof previousContent !== 'string') {
    return undefined;
  }
  return {
    path: record['path'],
    turnId: Math.floor(record['turnId']),
    proposedContent: record['proposedContent'],
    previousContent: previousContent as string | undefined,
    targetFsPath: record['targetFsPath'],
  };
}
