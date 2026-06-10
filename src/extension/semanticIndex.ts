export interface SemanticDocument {
  path: string;
  content: string;
}

interface SemanticChunkDraft {
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface SemanticChunk extends SemanticChunkDraft {
  embedding: number[];
}

export interface RankedSemanticChunk extends SemanticChunk {
  score: number;
}

export interface EmbeddingProvider {
  embed(inputs: string[]): Promise<number[][]>;
}

export interface SemanticIndexBuildOptions {
  maxChunkChars?: number;
  overlapLines?: number;
  maxChunks?: number;
  batchSize?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 900;
const DEFAULT_OVERLAP_LINES = 4;
const DEFAULT_MAX_CHUNKS = 600;
const DEFAULT_BATCH_SIZE = 32;
const RESULT_SNIPPET_MAX_CHARS = 260;

export function chunkDocument(
  document: SemanticDocument,
  options: Pick<SemanticIndexBuildOptions, 'maxChunkChars' | 'overlapLines'> = {}
): SemanticChunkDraft[] {
  const maxChunkChars = Math.max(200, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
  const overlapLines = Math.max(0, options.overlapLines ?? DEFAULT_OVERLAP_LINES);
  const lines = document.content.split('\n');
  const chunks: SemanticChunkDraft[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      const extraChars = line.length + (end > start ? 1 : 0);
      if (chars > 0 && chars + extraChars > maxChunkChars) {
        break;
      }
      chars += extraChars;
      end += 1;
    }

    if (end === start) {
      end += 1;
    }
    const text = lines.slice(start, end).join('\n').trim();
    if (text !== '') {
      chunks.push({
        path: document.path,
        lineStart: start + 1,
        lineEnd: end,
        text,
      });
    }

    if (end >= lines.length) {
      break;
    }
    start = Math.max(start + 1, end - overlapLines);
  }

  return chunks;
}

export async function buildSemanticIndex(
  documents: readonly SemanticDocument[],
  embeddingProvider: EmbeddingProvider,
  options: SemanticIndexBuildOptions = {}
): Promise<SemanticChunk[]> {
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const drafts: SemanticChunkDraft[] = [];

  for (const document of documents) {
    const chunks = chunkDocument(document, options);
    for (const chunk of chunks) {
      if (drafts.length >= maxChunks) {
        break;
      }
      drafts.push(chunk);
    }
    if (drafts.length >= maxChunks) {
      break;
    }
  }

  if (drafts.length === 0) {
    return [];
  }

  const vectors: number[][] = [];
  const chunkInputs = drafts.map((chunk) => `File: ${chunk.path}\n${chunk.text}`);
  for (let offset = 0; offset < chunkInputs.length; offset += batchSize) {
    const batch = chunkInputs.slice(offset, offset + batchSize);
    const embedded = await embeddingProvider.embed(batch);
    if (embedded.length !== batch.length) {
      throw new Error(
        `embedding backend returned ${embedded.length} vectors for ${batch.length} inputs`
      );
    }
    vectors.push(...embedded);
  }

  return drafts.map((draft, index) => ({
    ...draft,
    embedding: vectors[index] ?? [],
  }));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return Number.NEGATIVE_INFINITY;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankSemanticChunks(
  chunks: readonly SemanticChunk[],
  queryEmbedding: readonly number[],
  limit: number
): RankedSemanticChunk[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(chunk.embedding, queryEmbedding),
    }))
    .filter((chunk) => Number.isFinite(chunk.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);
}

function compactSnippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= RESULT_SNIPPET_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, RESULT_SNIPPET_MAX_CHARS)}...`;
}

export function formatSemanticResults(results: readonly RankedSemanticChunk[]): string {
  if (results.length === 0) {
    return '(no semantic matches)';
  }
  return results
    .map(
      (result) =>
        `${result.path}:${result.lineStart}-${result.lineEnd} (score ${result.score.toFixed(3)})\n${compactSnippet(result.text)}`
    )
    .join('\n\n');
}

interface OpenAIErrorPayload {
  message?: string;
}

interface OpenAIEmbeddingItem {
  index: number;
  embedding: number[];
}

interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingItem[];
  error?: OpenAIErrorPayload;
}

export interface OpenAIEmbeddingClientOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  constructor(private readonly options: OpenAIEmbeddingClientOptions) {}

  private embeddingsUrl(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/embeddings`;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const response = await fetch(this.embeddingsUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        input: inputs,
      }),
    });

    let payload: OpenAIEmbeddingResponse | undefined;
    try {
      payload = (await response.json()) as OpenAIEmbeddingResponse;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const message = payload?.error?.message || `HTTP ${response.status}`;
      throw new Error(`embedding request failed: ${message}`);
    }
    const data = payload?.data;
    if (!Array.isArray(data)) {
      throw new Error('embedding response did not include a data array');
    }
    const sorted = [...data].sort((a, b) => a.index - b.index);
    if (sorted.length !== inputs.length) {
      throw new Error(
        `embedding response contained ${sorted.length} vectors for ${inputs.length} inputs`
      );
    }
    return sorted.map((item) => {
      if (!Array.isArray(item.embedding) || !item.embedding.every((v) => typeof v === 'number')) {
        throw new Error('embedding response contained an invalid vector');
      }
      return item.embedding;
    });
  }
}
