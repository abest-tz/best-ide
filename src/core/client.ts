import { streamSSE } from './sse';
import type {
  AssistantTurn,
  ChatRequestOptions,
  ModelInfo,
  ToolCall,
} from './types';

export interface OpenAIClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

let toolCallCounter = 0;

function generateToolCallId(): string {
  toolCallCounter += 1;
  return `call_${Date.now().toString(36)}_${toolCallCounter}`;
}

/** Merges streamed tool-call deltas into complete tool calls, keyed by index. */
export function accumulateToolCallDeltas(
  accumulated: Map<number, ToolCall>,
  deltas: ToolCallDelta[]
): void {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    let call = accumulated.get(index);
    if (!call) {
      call = {
        id: delta.id ?? generateToolCallId(),
        type: 'function',
        function: { name: '', arguments: '' },
      };
      accumulated.set(index, call);
    }
    if (delta.id) {
      call.id = delta.id;
    }
    if (delta.function?.name) {
      call.function.name += delta.function.name;
    }
    if (delta.function?.arguments) {
      call.function.arguments += delta.function.arguments;
    }
  }
}

export class OpenAIClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAIClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.fetchFn(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to list models: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => ({ id: m.id }));
  }

  async chat(options: ChatRequestOptions, onText: (text: string) => void): Promise<AssistantTurn> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true,
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Chat request failed: HTTP ${response.status}\n${body}`);
    }
    if (!response.body) {
      throw new Error('Chat request failed: response has no body');
    }

    let content = '';
    let finishReason: string | null = null;
    const toolCalls = new Map<number, ToolCall>();

    for await (const payload of streamSSE(response.body)) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }
      if (choice.delta?.content) {
        content += choice.delta.content;
        onText(choice.delta.content);
      }
      if (choice.delta?.tool_calls) {
        accumulateToolCallDeltas(toolCalls, choice.delta.tool_calls);
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    return {
      content,
      toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
      finishReason,
    };
  }
}
