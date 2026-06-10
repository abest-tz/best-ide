import type { ChatMessage } from '../core/types';
import type { PersistedTranscriptItem } from '../shared/protocol';

const STORAGE_KEY = 'bestIde.conversationThreads.v1';
const DEFAULT_THREAD_TITLE = 'New chat';
const MAX_THREADS = 50;
const TITLE_MAX_LENGTH = 72;

export interface ThreadStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export type StoredTranscriptItem = PersistedTranscriptItem;

export interface StoredThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  transcript: StoredTranscriptItem[];
}

interface StoredThreadState {
  activeThreadId: string;
  threads: StoredThread[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export class ConversationThreadStore {
  private state: StoredThreadState;

  constructor(
    private readonly storage: ThreadStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () =>
      `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  ) {
    this.state = this.normalizeState(this.storage.get<unknown>(STORAGE_KEY));
  }

  getActiveThread(): StoredThread {
    return cloneThread(this.findActiveThread());
  }

  listThreads(): ThreadSummary[] {
    return [...this.state.threads]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        preview: summarizeThread(thread),
      }));
  }

  searchThreads(query: string): ThreadSummary[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return this.listThreads();
    }
    return this.listThreads().filter((thread) => {
      const source = this.state.threads.find((candidate) => candidate.id === thread.id);
      if (!source) {
        return false;
      }
      const haystack = `${source.title}\n${source.transcript.map((item) => item.text).join('\n')}`;
      return haystack.toLowerCase().includes(needle);
    });
  }

  async createThread(): Promise<StoredThread> {
    const timestamp = this.now().toISOString();
    const thread: StoredThread = {
      id: this.createId(),
      title: DEFAULT_THREAD_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      transcript: [],
    };
    this.state.threads.push(thread);
    this.state.activeThreadId = thread.id;
    this.trimThreadLimit();
    await this.persist();
    return cloneThread(this.findActiveThread());
  }

  async setActiveThread(id: string): Promise<StoredThread | undefined> {
    const thread = this.state.threads.find((candidate) => candidate.id === id);
    if (!thread) {
      return undefined;
    }
    this.state.activeThreadId = id;
    await this.persist();
    return cloneThread(thread);
  }

  async recordTurn(
    threadId: string,
    turn: {
      userText: string;
      assistantTexts: string[];
      messages: readonly ChatMessage[];
    }
  ): Promise<StoredThread | undefined> {
    const thread = this.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return undefined;
    }

    const hadUserMessage = thread.transcript.some((item) => item.kind === 'user');
    const userText = turn.userText.trim();
    if (userText) {
      thread.transcript.push({ kind: 'user', text: turn.userText });
      if (!hadUserMessage) {
        thread.title = titleFromFirstPrompt(turn.userText);
      }
    }
    for (const assistantText of turn.assistantTexts) {
      if (assistantText.trim()) {
        thread.transcript.push({ kind: 'assistant', text: assistantText });
      }
    }
    thread.messages = cloneMessages(turn.messages);
    thread.updatedAt = this.now().toISOString();
    await this.persist();
    return cloneThread(thread);
  }

  async recordFailedTurn(
    threadId: string,
    failure: { userText: string; errorMessage: string; messages: readonly ChatMessage[] }
  ): Promise<StoredThread | undefined> {
    const thread = this.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return undefined;
    }
    const hadUserMessage = thread.transcript.some((item) => item.kind === 'user');
    if (failure.userText.trim()) {
      thread.transcript.push({ kind: 'user', text: failure.userText });
      if (!hadUserMessage) {
        thread.title = titleFromFirstPrompt(failure.userText);
      }
    }
    thread.transcript.push({ kind: 'error', text: failure.errorMessage });
    thread.messages = cloneMessages(failure.messages);
    thread.updatedAt = this.now().toISOString();
    await this.persist();
    return cloneThread(thread);
  }

  exportThreadAsMarkdown(id: string): string | undefined {
    const thread = this.state.threads.find((candidate) => candidate.id === id);
    if (!thread) {
      return undefined;
    }
    const sections: string[] = [
      `# ${thread.title}`,
      '',
      `- Thread ID: \`${thread.id}\``,
      `- Created: ${thread.createdAt}`,
      `- Updated: ${thread.updatedAt}`,
      '',
      '## Conversation',
      '',
    ];
    if (thread.transcript.length === 0) {
      sections.push('_No messages yet._');
      return sections.join('\n');
    }
    for (const entry of thread.transcript) {
      sections.push(`### ${labelForKind(entry.kind)}`);
      sections.push('');
      sections.push(entry.text || '_Empty message_');
      sections.push('');
    }
    return sections.join('\n');
  }

  exportThreadAsJson(id: string): string | undefined {
    const thread = this.state.threads.find((candidate) => candidate.id === id);
    if (!thread) {
      return undefined;
    }
    return JSON.stringify(thread, null, 2);
  }

  private normalizeState(value: unknown): StoredThreadState {
    if (isStoredState(value) && value.threads.length > 0) {
      const threads = value.threads.map((thread) => sanitizeThread(thread));
      const activeThreadId = threads.some((thread) => thread.id === value.activeThreadId)
        ? value.activeThreadId
        : threads[0]!.id;
      return { activeThreadId, threads };
    }
    const timestamp = this.now().toISOString();
    const thread: StoredThread = {
      id: this.createId(),
      title: DEFAULT_THREAD_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      transcript: [],
    };
    return { activeThreadId: thread.id, threads: [thread] };
  }

  private trimThreadLimit(): void {
    if (this.state.threads.length <= MAX_THREADS) {
      return;
    }
    this.state.threads = [...this.state.threads]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(this.state.threads.length - MAX_THREADS);
    if (!this.state.threads.some((thread) => thread.id === this.state.activeThreadId)) {
      this.state.activeThreadId = this.state.threads[this.state.threads.length - 1]!.id;
    }
  }

  private findActiveThread(): StoredThread {
    const thread = this.state.threads.find((candidate) => candidate.id === this.state.activeThreadId);
    if (thread) {
      return thread;
    }
    const fallback = this.state.threads[0];
    if (!fallback) {
      const timestamp = this.now().toISOString();
      const created: StoredThread = {
        id: this.createId(),
        title: DEFAULT_THREAD_TITLE,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
        transcript: [],
      };
      this.state = { activeThreadId: created.id, threads: [created] };
      return created;
    }
    this.state.activeThreadId = fallback.id;
    return fallback;
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.state);
  }
}

function sanitizeThread(thread: StoredThread): StoredThread {
  const createdAt = isIsoDateString(thread.createdAt) ? thread.createdAt : new Date(0).toISOString();
  const updatedAt = isIsoDateString(thread.updatedAt) ? thread.updatedAt : createdAt;
  return {
    id: typeof thread.id === 'string' && thread.id ? thread.id : `thread-${Math.random().toString(36).slice(2, 8)}`,
    title:
      typeof thread.title === 'string' && thread.title.trim()
        ? thread.title.trim().slice(0, TITLE_MAX_LENGTH)
        : DEFAULT_THREAD_TITLE,
    createdAt,
    updatedAt,
    messages: Array.isArray(thread.messages) ? thread.messages.filter(isChatMessage).map(cloneMessage) : [],
    transcript: Array.isArray(thread.transcript)
      ? thread.transcript.filter(isTranscriptItem).map((item) => ({ kind: item.kind, text: item.text }))
      : [],
  };
}

function labelForKind(kind: StoredTranscriptItem['kind']): string {
  switch (kind) {
    case 'assistant':
      return 'Assistant';
    case 'notice':
      return 'Notice';
    case 'error':
      return 'Error';
    case 'user':
      return 'User';
  }
}

function titleFromFirstPrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return DEFAULT_THREAD_TITLE;
  }
  if (singleLine.length <= TITLE_MAX_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, TITLE_MAX_LENGTH - 3)}...`;
}

function summarizeThread(thread: StoredThread): string {
  const recent = [...thread.transcript]
    .reverse()
    .find((item) => item.kind === 'user' || item.kind === 'assistant');
  if (!recent) {
    return 'No messages yet';
  }
  const singleLine = recent.text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
}

function cloneThread(thread: StoredThread): StoredThread {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: cloneMessages(thread.messages),
    transcript: thread.transcript.map((item) => ({ kind: item.kind, text: item.text })),
  };
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => cloneMessage(message));
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return structuredClone(message);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isTranscriptItem(value: unknown): value is StoredTranscriptItem {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'user' ||
      candidate.kind === 'assistant' ||
      candidate.kind === 'notice' ||
      candidate.kind === 'error') &&
    typeof candidate.text === 'string'
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === 'system' ||
      candidate.role === 'user' ||
      candidate.role === 'assistant' ||
      candidate.role === 'tool') &&
    typeof candidate.content === 'string'
  );
}

function isStoredState(value: unknown): value is StoredThreadState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.activeThreadId === 'string' &&
    Array.isArray(candidate.threads) &&
    candidate.threads.every((thread) => isThread(thread))
  );
}

function isThread(value: unknown): value is StoredThread {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.transcript)
  );
}
