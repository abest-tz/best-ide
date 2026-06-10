import { describe, expect, it } from 'vitest';
import {
  getBackendsForOperation,
  resolveBackendRouting,
  resolveChatModel,
  resolveEmbeddingModel,
  resolveInlineCompletionModel,
} from '../src/extension/backendRouting';

function resolveWith(overrides: Partial<Parameters<typeof resolveBackendRouting>[0]> = {}) {
  return resolveBackendRouting({
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: 'local-chat',
    embeddingModel: 'local-embed',
    inlineCompletionsModel: 'local-inline',
    backends: {},
    backendPreset: 'local',
    backendRouting: {},
    modelRouting: {},
    ...overrides,
  });
}

describe('resolveBackendRouting', () => {
  it('defaults to a single local backend when no custom backends are configured', () => {
    const state = resolveWith();
    expect(state.backends.map((backend) => backend.id)).toEqual(['local']);
    expect(state.routes.chat).toEqual(['local']);
    expect(state.routes.models).toEqual(['local']);
    expect(state.routes.embeddings).toEqual(['local']);
    expect(state.routes.inlineCompletions).toEqual(['local']);
  });

  it('orders backends by the selected preset roles', () => {
    const state = resolveWith({
      backendPreset: 'cost',
      backends: {
        cloudFast: {
          baseUrl: 'https://cost.example.com/v1',
          role: 'cost',
          model: 'cost-model',
        },
        cloudBest: {
          baseUrl: 'https://quality.example.com/v1',
          role: 'quality',
          model: 'quality-model',
        },
      },
    });

    expect(state.routes.chat).toEqual(['cloudFast', 'local', 'cloudBest']);
    expect(getBackendsForOperation(state, 'chat').map((backend) => backend.id)).toEqual([
      'cloudFast',
      'local',
      'cloudBest',
    ]);
  });

  it('applies explicit route overrides and drops unknown backend ids', () => {
    const state = resolveWith({
      backends: {
        cloud: { baseUrl: 'https://cloud.example.com/v1', role: 'quality' },
      },
      backendRouting: {
        chat: ['cloud', 'missing', 'cloud', 'local'],
        models: ['local'],
      },
    });

    expect(state.routes.chat).toEqual(['cloud', 'local']);
    expect(state.routes.models).toEqual(['local']);
    expect(state.routes.embeddings).toEqual(['cloud', 'local']);
  });

  it('supports disabling the local backend when another backend is configured', () => {
    const state = resolveWith({
      backends: {
        local: { enabled: false },
        cloud: { baseUrl: 'https://cloud.example.com/v1', role: 'quality' },
      },
      backendPreset: 'quality',
    });

    expect(state.backends.map((backend) => backend.id)).toEqual(['cloud']);
    expect(state.routes.chat).toEqual(['cloud']);
  });
});

describe('model resolution', () => {
  it('uses explicit per-mode routing overrides first', () => {
    const state = resolveWith({
      modelRouting: {
        ask: 'ask-global',
        embeddings: 'embed-global',
        inlineCompletions: 'inline-global',
      },
      backends: {
        cloud: {
          baseUrl: 'https://cloud.example.com/v1',
          role: 'quality',
          model: 'cloud-default',
          askModel: 'ask-backend',
          embeddingModel: 'embed-backend',
          inlineCompletionsModel: 'inline-backend',
        },
      },
      backendRouting: {
        chat: ['cloud'],
        embeddings: ['cloud'],
        inlineCompletions: ['cloud'],
      },
    });
    const backend = getBackendsForOperation(state, 'chat')[0]!;

    expect(resolveChatModel(state, backend, 'ask', 'picked')).toBe('ask-global');
    expect(resolveEmbeddingModel(state, backend)).toBe('embed-global');
    expect(resolveInlineCompletionModel(state, backend, 'picked-inline')).toBe('inline-global');
  });

  it('uses the selected picker model when no route override exists', () => {
    const state = resolveWith({
      modelRouting: {},
      backends: {
        cloud: {
          baseUrl: 'https://cloud.example.com/v1',
          role: 'quality',
          model: 'cloud-default',
          askModel: 'cloud-ask',
        },
      },
      backendRouting: {
        chat: ['cloud'],
      },
    });
    const backend = getBackendsForOperation(state, 'chat')[0]!;

    expect(resolveChatModel(state, backend, 'ask', 'picked-model')).toBe('cloud-ask');
    expect(resolveChatModel(state, backend, 'agent', 'picked-model')).toBe('picked-model');
  });
});
