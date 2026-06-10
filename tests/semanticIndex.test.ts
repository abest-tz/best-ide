import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIEmbeddingClient,
  buildSemanticIndex,
  chunkDocument,
  formatSemanticResults,
  rankSemanticChunks,
  type SemanticChunk,
} from '../src/extension/semanticIndex';

describe('chunkDocument', () => {
  it('splits documents into overlapping line-based chunks', () => {
    const longLineA = 'a'.repeat(120);
    const longLineB = 'b'.repeat(120);
    const longLineC = 'c'.repeat(120);
    const longLineD = 'd'.repeat(120);
    const chunks = chunkDocument(
      {
        path: 'src/a.ts',
        content: [longLineA, longLineB, longLineC, longLineD].join('\n'),
      },
      { maxChunkChars: 200, overlapLines: 1 }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ path: 'src/a.ts', lineStart: 1, lineEnd: 1 });
    expect(chunks[1]).toMatchObject({ path: 'src/a.ts', lineStart: 2, lineEnd: 2 });
  });
});

describe('buildSemanticIndex', () => {
  it('embeds chunked documents and preserves chunk metadata', async () => {
    const embed = vi.fn(async (inputs: string[]) => inputs.map((_, index) => [index + 1, 1]));
    const longLine = 'x'.repeat(150);
    const chunks = await buildSemanticIndex(
      [
        {
          path: 'src/b.ts',
          content: [longLine, longLine, longLine].join('\n'),
        },
      ],
      { embed },
      { maxChunkChars: 200, overlapLines: 1, batchSize: 1 }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(embed).toHaveBeenCalled();
    expect(chunks[0]).toMatchObject({
      path: 'src/b.ts',
      lineStart: 1,
    });
    expect(chunks[0]?.embedding).toEqual([1, 1]);
  });
});

describe('ranking and formatting', () => {
  it('ranks chunks by cosine similarity and formats results', () => {
    const chunks: SemanticChunk[] = [
      {
        path: 'src/high.ts',
        lineStart: 10,
        lineEnd: 20,
        text: 'high similarity chunk',
        embedding: [1, 0],
      },
      {
        path: 'src/low.ts',
        lineStart: 3,
        lineEnd: 6,
        text: 'low similarity chunk',
        embedding: [0, 1],
      },
    ];

    const ranked = rankSemanticChunks(chunks, [0.9, 0.1], 2);
    expect(ranked[0]?.path).toBe('src/high.ts');

    const formatted = formatSemanticResults(ranked);
    expect(formatted).toContain('src/high.ts:10-20');
    expect(formatted).toContain('score');
  });
});

describe('OpenAIEmbeddingClient', () => {
  it('sorts embeddings by index in API responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = new OpenAIEmbeddingClient({
        baseUrl: 'http://localhost:1234/v1',
        apiKey: '',
        model: 'embeddings-model',
      });
      const vectors = await client.embed(['one', 'two']);
      expect(vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
