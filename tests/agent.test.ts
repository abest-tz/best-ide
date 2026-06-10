import { describe, expect, it, vi } from 'vitest';
import { Agent, type AgentCallbacks, type ChatClient } from '../src/core/agent';
import type { WorkspaceHost } from '../src/core/host';
import { createTools } from '../src/core/tools';
import type { AssistantTurn, ChatMessage, ChatRequestOptions, ToolCall } from '../src/core/types';

function mockHost(overrides: Partial<WorkspaceHost> = {}): WorkspaceHost {
  return {
    readFile: vi.fn().mockResolvedValue('file contents'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue(''),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    ...overrides,
  };
}

/** Fake client that replays scripted turns and records each request. */
function scriptedClient(turns: AssistantTurn[]): ChatClient & { requests: ChatRequestOptions[] } {
  const requests: ChatRequestOptions[] = [];
  let i = 0;
  return {
    requests,
    async chat(options: ChatRequestOptions, onText: (t: string) => void): Promise<AssistantTurn> {
      requests.push(structuredClone(options));
      const turn = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      if (turn.content) {
        onText(turn.content);
      }
      return turn;
    },
  };
}

function textTurn(content: string): AssistantTurn {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function toolTurn(...calls: Array<[name: string, args: Record<string, unknown>]>): AssistantTurn {
  const toolCalls: ToolCall[] = calls.map(([name, args], idx) => ({
    id: `call_${idx}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }));
  return { content: '', toolCalls, finishReason: 'tool_calls' };
}

interface ParsedToolError {
  code: string;
  tool: string;
  message: string;
  retryable: boolean;
  details?: string[];
}

function parseToolError(result: string): ParsedToolError {
  expect(result).toMatch(/^Error:/);
  return JSON.parse(result.slice('Error:'.length).trim()) as ParsedToolError;
}

function callbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onAssistantText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
    onNotice: vi.fn(),
    ...overrides,
  };
}

function makeAgent(client: ChatClient, host: WorkspaceHost, opts: Partial<{ maxSteps: number; autoApprove: boolean }> = {}) {
  return new Agent({ client, host, model: 'test-model', temperature: 0, ...opts });
}

describe('Agent basic chat', () => {
  it('streams text and records history for a plain response', async () => {
    const client = scriptedClient([textTurn('Hello!')]);
    const agent = makeAgent(client, mockHost());
    const cb = callbacks();

    await agent.run('hi', cb);

    expect(cb.onAssistantText).toHaveBeenCalledWith('Hello!');
    expect(agent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(agent.messages[2]?.content).toBe('Hello!');
  });

  it('sends the system prompt and tool definitions to the model', async () => {
    const client = scriptedClient([textTurn('ok')]);
    const agent = makeAgent(client, mockHost());

    await agent.run('hi', callbacks());

    const req = client.requests[0]!;
    expect(req.model).toBe('test-model');
    expect(req.messages[0]?.role).toBe('system');
    expect(req.tools?.map((t) => t.function.name)).toContain('read_file');
  });

  it('can resume from persisted history messages', async () => {
    const client = scriptedClient([textTurn('continued')]);
    const persisted: ChatMessage[] = [
      { role: 'system', content: 'Persisted system prompt' },
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ];
    const agent = new Agent({
      client,
      host: mockHost(),
      model: 'test-model',
      temperature: 0,
      initialMessages: persisted,
    });

    await agent.run('new question', callbacks());

    expect(client.requests[0]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(client.requests[0]?.messages[0]?.content).toBe('Persisted system prompt');
  });

  it('keeps history across runs and reset clears it back to the system prompt', async () => {
    const client = scriptedClient([textTurn('one'), textTurn('two')]);
    const agent = makeAgent(client, mockHost());

    await agent.run('first', callbacks());
    await agent.run('second', callbacks());
    expect(agent.messages.filter((m) => m.role === 'user')).toHaveLength(2);

    agent.reset();
    expect(agent.messages).toHaveLength(1);
    expect(agent.messages[0]?.role).toBe('system');
  });
});

describe('Agent tool dispatch', () => {
  it('auto-executes read-only tools and feeds results back to the model', async () => {
    const client = scriptedClient([
      toolTurn(['read_file', { path: 'a.ts' }]),
      textTurn('summary'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host);

    await agent.run('what is in a.ts?', cb);

    expect(host.readFile).toHaveBeenCalledWith('a.ts');
    expect(cb.requestApproval).not.toHaveBeenCalled();
    expect(cb.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'call_0' }), false);
    expect(cb.onToolResult).toHaveBeenCalledWith('call_0', 'file contents');

    const secondRequest = client.requests[1]!;
    const toolMessage = secondRequest.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ tool_call_id: 'call_0', content: 'file contents' });
  });

  it('requests approval for run_command and executes on approve', async () => {
    const client = scriptedClient([
      toolTurn(['run_command', { command: 'echo hi' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host);

    await agent.run('write it', cb);

    expect(cb.requestApproval).toHaveBeenCalledOnce();
    expect(host.exec).toHaveBeenCalledWith('echo hi', expect.any(Number));
  });

  it('validates run_command arguments before requesting approval', async () => {
    const client = scriptedClient([toolTurn(['run_command', {}]), textTurn('done')]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host);

    await agent.run('run a command', cb);

    expect(cb.requestApproval).not.toHaveBeenCalled();
    expect(host.exec).not.toHaveBeenCalled();
    const toolMessage = client.requests[1]!.messages.find((message) => message.role === 'tool');
    const error = parseToolError(toolMessage?.content ?? '');
    expect(error).toMatchObject({
      code: 'invalid_tool_arguments',
      tool: 'run_command',
      retryable: true,
    });
    expect(error.details).toContain('missing required argument "command"');
  });

  it('does not request pre-approval for write_file edits', async () => {
    const client = scriptedClient([
      toolTurn(['write_file', { path: 'out.ts', content: 'x' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host);

    await agent.run('write it', cb);

    expect(cb.requestApproval).not.toHaveBeenCalled();
    expect(host.writeFile).toHaveBeenCalledWith('out.ts', 'x');
  });

  it('treats mutating tools as unavailable in ask mode', async () => {
    const client = scriptedClient([
      toolTurn(['write_file', { path: 'out.ts', content: 'x' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = new Agent({
      client,
      host,
      model: 'test-model',
      temperature: 0,
      tools: createTools('ask'),
    });

    await agent.run('review only', cb);

    expect(host.writeFile).not.toHaveBeenCalled();
    const toolMessage = client.requests[1]!.messages.find((message) => message.role === 'tool');
    const error = parseToolError(toolMessage?.content ?? '');
    expect(error).toMatchObject({
      code: 'unknown_tool',
      tool: 'write_file',
      retryable: true,
    });
  });

  it('does not execute rejected tools and informs the model', async () => {
    const client = scriptedClient([
      toolTurn(['run_command', { command: 'rm -rf /' }]),
      textTurn('understood'),
    ]);
    const host = mockHost();
    const cb = callbacks({ requestApproval: vi.fn().mockResolvedValue(false) });
    const agent = makeAgent(client, host);

    await agent.run('clean up', cb);

    expect(host.exec).not.toHaveBeenCalled();
    const toolMessage = client.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/rejected/i);
  });

  it('skips approval when autoApprove is enabled', async () => {
    const client = scriptedClient([
      toolTurn(['run_command', { command: 'pwd' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host, { autoApprove: true });

    await agent.run('go', cb);

    expect(cb.requestApproval).not.toHaveBeenCalled();
    expect(host.exec).toHaveBeenCalledWith('pwd', expect.any(Number));
  });

  it('executes parallel tool calls in order', async () => {
    const client = scriptedClient([
      toolTurn(['read_file', { path: 'a' }], ['read_file', { path: 'b' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const agent = makeAgent(client, host);

    await agent.run('read both', callbacks());

    expect(host.readFile).toHaveBeenNthCalledWith(1, 'a');
    expect(host.readFile).toHaveBeenNthCalledWith(2, 'b');
    const toolMessages = client.requests[1]!.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_0', 'call_1']);
  });

  it('feeds tool execution errors back to the model instead of throwing', async () => {
    const client = scriptedClient([
      toolTurn(['read_file', { path: 'missing' }]),
      textTurn('sorry'),
    ]);
    const host = mockHost({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) });
    const agent = makeAgent(client, host);

    await agent.run('read', callbacks());

    const toolMessage = client.requests[1]!.messages.find((m) => m.role === 'tool');
    const error = parseToolError(toolMessage?.content ?? '');
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'read_file',
      retryable: false,
    });
    expect(error.message).toMatch(/ENOENT/);
  });
});

describe('Agent step cap', () => {
  it('stops after maxSteps and emits a notice', async () => {
    const client = scriptedClient([toolTurn(['read_file', { path: 'a' }])]);
    const cb = callbacks();
    const agent = makeAgent(client, mockHost(), { maxSteps: 3 });

    await agent.run('loop forever', cb);

    expect(client.requests).toHaveLength(3);
    expect(cb.onNotice).toHaveBeenCalledWith(expect.stringMatching(/step limit/i));
  });

  it('continues after maxSteps when continuation is approved', async () => {
    const client = scriptedClient([
      toolTurn(['read_file', { path: 'a' }]),
      toolTurn(['read_file', { path: 'b' }]),
      textTurn('done'),
    ]);
    const requestStepLimitContinuation = vi.fn().mockResolvedValue(true);
    const cb = callbacks({ requestStepLimitContinuation });
    const agent = makeAgent(client, mockHost(), { maxSteps: 2 });

    await agent.run('keep going', cb);

    expect(client.requests).toHaveLength(3);
    expect(requestStepLimitContinuation).toHaveBeenCalledWith({
      maxSteps: 2,
      completedSteps: 2,
    });
    expect(cb.onNotice).toHaveBeenCalledWith(expect.stringMatching(/continuing after 2 model turns/i));
  });

  it('stops when continuation is rejected at the step limit', async () => {
    const client = scriptedClient([toolTurn(['read_file', { path: 'a' }])]);
    const requestStepLimitContinuation = vi.fn().mockResolvedValue(false);
    const cb = callbacks({ requestStepLimitContinuation });
    const agent = makeAgent(client, mockHost(), { maxSteps: 2 });

    await agent.run('loop forever', cb);

    expect(client.requests).toHaveLength(2);
    expect(requestStepLimitContinuation).toHaveBeenCalledWith({
      maxSteps: 2,
      completedSteps: 2,
    });
    expect(cb.onNotice).toHaveBeenCalledWith(expect.stringMatching(/step limit/i));
  });
});

describe('Agent errors', () => {
  it('propagates client errors', async () => {
    const client: ChatClient = {
      chat: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const agent = makeAgent(client, mockHost());
    await expect(agent.run('hi', callbacks())).rejects.toThrow(/connection refused/);
  });

  it('removes the pending user message when the first request fails so retry works', async () => {
    let fail = true;
    const client: ChatClient = {
      async chat(_options, onText) {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        onText('recovered');
        return textTurn('recovered');
      },
    };
    const agent = makeAgent(client, mockHost());
    await expect(agent.run('hi', callbacks())).rejects.toThrow('boom');
    expect(agent.messages.filter((m) => m.role === 'user')).toHaveLength(0);

    await agent.run('hi again', callbacks());
    expect(agent.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});
