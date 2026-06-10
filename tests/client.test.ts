import { describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../src/core/client';
import type { ChatMessage } from '../src/core/types';

function sseResponse(payloads: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('OpenAIClient.listModels', () => {
  it('returns model ids from /models', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama-3.1' }] }), {
        status: 200,
      })
    );
    const client = new OpenAIClient({ baseUrl: 'http://localhost:1234/v1', fetchFn });
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen2.5-coder', 'llama-3.1']);
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.anything());
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new OpenAIClient({ baseUrl: 'http://localhost:1234/v1/', fetchFn });
    await client.listModels();
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.anything());
  });

  it('throws a descriptive error on non-200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    await expect(client.listModels()).rejects.toThrow(/500/);
  });
});

describe('OpenAIClient.chat', () => {
  it('streams text deltas and returns accumulated content', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])
    );
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const chunks: string[] = [];
    const turn = await client.chat({ model: 'm', messages }, (t) => chunks.push(t));
    expect(chunks).toEqual(['Hel', 'lo']);
    expect(turn.content).toBe('Hello');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.finishReason).toBe('stop');
  });

  it('accumulates tool calls streamed as fragmented deltas', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ])
    );
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const turn = await client.chat({ model: 'm', messages }, () => {});
    expect(turn.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);
    expect(turn.finishReason).toBe('tool_calls');
  });

  it('handles multiple parallel tool calls by index', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', type: 'function', function: { name: 'f1', arguments: '{}' } },
                  { index: 1, id: 'b', type: 'function', function: { name: 'f2', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      ])
    );
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const turn = await client.chat({ model: 'm', messages }, () => {});
    expect(turn.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('generates ids for tool calls when the server omits them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{}' } }] } },
          ],
        }),
      ])
    );
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const turn = await client.chat({ model: 'm', messages }, () => {});
    expect(turn.toolCalls[0]?.id).toMatch(/^call_/);
  });

  it('sends tools, temperature, and stream flag in the request body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([]));
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const tools = [
      { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } },
    ];
    await client.chat({ model: 'm', messages, tools, temperature: 0.5 }, () => {});
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.tools).toEqual(tools);
  });

  it('throws a descriptive error including the response body on HTTP failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('model not loaded', { status: 404 }));
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    await expect(client.chat({ model: 'm', messages }, () => {})).rejects.toThrow(
      /404.*model not loaded/s
    );
  });

  it('throws when the response has no body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    await expect(client.chat({ model: 'm', messages }, () => {})).rejects.toThrow(/body/i);
  });

  it('ignores malformed JSON payloads in the stream', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(['not json', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })])
    );
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', fetchFn });
    const turn = await client.chat({ model: 'm', messages }, () => {});
    expect(turn.content).toBe('ok');
  });

  it('sends an Authorization header when apiKey is provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([]));
    const client = new OpenAIClient({ baseUrl: 'http://x/v1', apiKey: 'sk-test', fetchFn });
    await client.chat({ model: 'm', messages }, () => {});
    const headers = fetchFn.mock.calls[0]![1].headers;
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });
});
