import { describe, expect, it } from 'vitest';
import { createSSEDecoder, streamSSE } from '../src/core/sse';

describe('createSSEDecoder', () => {
  it('yields data payloads from complete events', () => {
    const decoder = createSSEDecoder();
    const out = decoder.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('buffers events split across chunks', () => {
    const decoder = createSSEDecoder();
    expect(decoder.push('data: {"a"')).toEqual([]);
    expect(decoder.push(':1}\n')).toEqual(['{"a":1}']);
  });

  it('handles CRLF line endings', () => {
    const decoder = createSSEDecoder();
    expect(decoder.push('data: hello\r\n\r\n')).toEqual(['hello']);
  });

  it('ignores comment lines and empty lines', () => {
    const decoder = createSSEDecoder();
    expect(decoder.push(': keep-alive\n\ndata: x\n\n')).toEqual(['x']);
  });

  it('handles data lines without a space after the colon', () => {
    const decoder = createSSEDecoder();
    expect(decoder.push('data:{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it('flush returns a trailing payload missing a final newline', () => {
    const decoder = createSSEDecoder();
    expect(decoder.push('data: tail')).toEqual([]);
    expect(decoder.flush()).toEqual(['tail']);
  });

  it('flush returns nothing when buffer is empty or not a data line', () => {
    const decoder = createSSEDecoder();
    decoder.push('data: x\n');
    expect(decoder.flush()).toEqual([]);
  });
});

describe('streamSSE', () => {
  function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  it('yields payloads across chunk boundaries and stops at [DONE]', async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\nda', 'ta: {"b":2}\n\ndata: [DONE]\n\n']);
    const seen: string[] = [];
    for await (const payload of streamSSE(body)) {
      seen.push(payload);
    }
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles streams without a [DONE] sentinel', async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\n']);
    const seen: string[] = [];
    for await (const payload of streamSSE(body)) {
      seen.push(payload);
    }
    expect(seen).toEqual(['{"a":1}']);
  });
});
