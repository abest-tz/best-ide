export interface SSEDecoder {
  push(chunk: string): string[];
  flush(): string[];
}

const DATA_PREFIX = /^data:\s?/;

/**
 * Incremental, line-based SSE decoder. OpenAI-compatible servers emit one
 * `data:` line per event, so multi-line data fields are not supported.
 */
export function createSSEDecoder(): SSEDecoder {
  let buffer = '';

  function extractPayloads(lines: string[]): string[] {
    const payloads: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (DATA_PREFIX.test(line)) {
        payloads.push(line.replace(DATA_PREFIX, ''));
      }
    }
    return payloads;
  }

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return extractPayloads(lines);
    },
    flush(): string[] {
      const remaining = buffer;
      buffer = '';
      return remaining ? extractPayloads([remaining]) : [];
    },
  };
}

const DONE_SENTINEL = '[DONE]';

/** Yields SSE data payloads from a byte stream, stopping at the [DONE] sentinel. */
export async function* streamSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = createSSEDecoder();
  const textDecoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const payload of decoder.push(textDecoder.decode(value, { stream: true }))) {
        if (payload === DONE_SENTINEL) {
          return;
        }
        yield payload;
      }
    }
    for (const payload of decoder.flush()) {
      if (payload === DONE_SENTINEL) {
        return;
      }
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}
