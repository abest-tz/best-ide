import type { WorkspaceHost } from './host';
import {
  createTools,
  executePreparedToolCall,
  findTool,
  formatToolError,
  prepareToolCall,
  toToolDefinitions,
  type ToolSpec,
} from './tools';
import type { AssistantTurn, ChatMessage, ChatRequestOptions, ToolCall } from './types';

/** Minimal client surface the agent needs; satisfied by OpenAIClient. */
export interface ChatClient {
  chat(options: ChatRequestOptions, onText: (text: string) => void): Promise<AssistantTurn>;
}

export interface StepLimitContext {
  maxSteps: number;
  completedSteps: number;
}

export interface AgentCallbacks {
  onAssistantText(text: string): void;
  onToolCall(call: ToolCall, mutating: boolean): void;
  onToolResult(callId: string, result: string): void;
  requestApproval(call: ToolCall): Promise<boolean>;
  onNotice(message: string): void;
  requestStepLimitContinuation?(context: StepLimitContext): Promise<boolean>;
}

export interface AgentOptions {
  client: ChatClient;
  host: WorkspaceHost;
  model: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxSteps?: number;
  autoApprove?: boolean;
  systemPrompt?: string;
  initialMessages?: ChatMessage[];
}

export const DEFAULT_SYSTEM_PROMPT = `You are a coding agent running inside an IDE, operating on the user's workspace.

You have tools to read files, list directories, search code with regex and semantic embeddings, inspect diagnostics/symbols/git state, call configured MCP tools, apply file edits, and run shell commands. Use them to investigate and complete the user's request. Rules:
- Gather context with read-only tools before making changes.
- Paths are relative to the workspace root.
- write_file overwrites the whole file: always read a file before rewriting it, and include its full new contents.
- Prefer search_replace for targeted edits when possible.
- Tool failures are returned as structured JSON after "Error:". Use error.retryable and error.details to correct arguments and retry when appropriate.
- Keep changes minimal and focused on the request.
- When done, reply with a brief summary of what you did. Do not call tools once the task is complete.`;

const DEFAULT_MAX_STEPS = 25;
const PRE_APPROVAL_TOOL_NAMES = new Set(['run_command']);

export class Agent {
  private readonly client: ChatClient;
  private readonly host: WorkspaceHost;
  private readonly tools: ToolSpec[];
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly maxSteps: number;
  private readonly autoApprove: boolean;
  private readonly history: ChatMessage[];

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.host = options.host;
    this.tools = options.tools ?? createTools();
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.autoApprove = options.autoApprove ?? false;
    this.history = this.buildInitialHistory(options);
  }

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  reset(): void {
    this.history.splice(1);
  }

  private buildInitialHistory(options: AgentOptions): ChatMessage[] {
    const defaultSystemMessage: ChatMessage = {
      role: 'system',
      content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };
    const initialMessages = options.initialMessages?.map((message) => structuredClone(message)) ?? [];
    if (initialMessages.length === 0) {
      return [defaultSystemMessage];
    }
    if (initialMessages[0]?.role !== 'system') {
      return [defaultSystemMessage, ...initialMessages];
    }
    return initialMessages;
  }

  async run(userMessage: string, callbacks: AgentCallbacks, signal?: AbortSignal): Promise<void> {
    const lengthBeforeRun = this.history.length;
    this.history.push({ role: 'user', content: userMessage });

    try {
      if (this.maxSteps <= 0) {
        callbacks.onNotice(
          `Stopped: reached the step limit of ${this.maxSteps} model turns. Send a follow-up message to continue.`
        );
        return;
      }

      let completedSteps = 0;
      while (true) {
        if (completedSteps > 0 && completedSteps % this.maxSteps === 0) {
          const shouldContinue = callbacks.requestStepLimitContinuation
            ? await callbacks.requestStepLimitContinuation({
                maxSteps: this.maxSteps,
                completedSteps,
              })
            : false;
          if (!shouldContinue) {
            callbacks.onNotice(
              `Stopped: reached the step limit of ${this.maxSteps} model turns. Continue from the step-limit card or send a follow-up message to continue.`
            );
            return;
          }
          callbacks.onNotice(`Continuing after ${completedSteps} model turns.`);
        }

        const turn = await this.client.chat(
          {
            model: this.model,
            messages: this.history,
            tools: toToolDefinitions(this.tools),
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            ...(signal ? { signal } : {}),
          },
          callbacks.onAssistantText
        );
        completedSteps += 1;

        this.history.push({
          role: 'assistant',
          content: turn.content,
          ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
        });

        if (turn.toolCalls.length === 0) {
          return;
        }

        for (const call of turn.toolCalls) {
          const result = await this.dispatchToolCall(call, callbacks);
          this.history.push({ role: 'tool', content: result, tool_call_id: call.id });
          callbacks.onToolResult(call.id, result);
        }
      }
    } catch (error) {
      // Roll back the partial exchange so the user can simply retry.
      this.history.splice(lengthBeforeRun);
      throw error;
    }
  }

  private async dispatchToolCall(call: ToolCall, callbacks: AgentCallbacks): Promise<string> {
    const tool = findTool(this.tools, call.function.name);
    const mutating = tool?.mutating ?? false;
    callbacks.onToolCall(call, mutating);

    const prepared = prepareToolCall(this.tools, call);
    if (!prepared.ok) {
      return formatToolError(prepared.error);
    }

    if (mutating && !this.autoApprove && PRE_APPROVAL_TOOL_NAMES.has(call.function.name)) {
      const approved = await callbacks.requestApproval(call);
      if (!approved) {
        return 'Error: the user rejected this tool call. Do not retry it; ask the user how to proceed instead.';
      }
    }

    return executePreparedToolCall(prepared.prepared, this.host);
  }
}
