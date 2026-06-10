import { describe, expect, it, vi } from 'vitest';
import { Agent, type AgentCallbacks, type ChatClient } from '../src/core/agent';
import type { WorkspaceHost } from '../src/core/host';
import type { AssistantTurn, ChatRequestOptions, ToolCall } from '../src/core/types';

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

  it('requests approval for mutating tools and executes on approve', async () => {
    const client = scriptedClient([
      toolTurn(['write_file', { path: 'out.ts', content: 'x' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host);

    await agent.run('write it', cb);

    expect(cb.requestApproval).toHaveBeenCalledOnce();
    expect(host.writeFile).toHaveBeenCalledWith('out.ts', 'x');
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
      toolTurn(['write_file', { path: 'o', content: 'c' }]),
      textTurn('done'),
    ]);
    const host = mockHost();
    const cb = callbacks();
    const agent = makeAgent(client, host, { autoApprove: true });

    await agent.run('go', cb);

    expect(cb.requestApproval).not.toHaveBeenCalled();
    expect(host.writeFile).toHaveBeenCalled();
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
    expect(toolMessage?.content).toMatch(/^Error:.*ENOENT/);
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
