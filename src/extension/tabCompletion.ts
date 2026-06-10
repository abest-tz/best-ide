import * as vscode from 'vscode';
import { OpenAIClient } from '../core/client';
import {
  buildInlineCompletionContext,
  buildInlineCompletionMessages,
  finalizeInlineCompletion,
} from './inlineCompletion';
import {
  getBackendsForOperation,
  resolveBackendRouting,
  resolveInlineCompletionModel,
  type BackendProfile,
  type BackendRoutingState,
} from './backendRouting';

const INLINE_COMPLETION_TEMPERATURE = 0.1;
const DISCOVERED_MODEL_TTL_MS = 30_000;

interface InlineCompletionConfig {
  enabled: boolean;
  fallbackModel: string;
  backendRouting: BackendRoutingState;
}

interface CachedDiscoveredModel {
  model: string;
  expiresAtMs: number;
}

function readInlineCompletionConfig(): InlineCompletionConfig {
  const config = vscode.workspace.getConfiguration('bestIde');
  const baseUrl = config.get<string>('baseUrl', 'http://localhost:1234/v1');
  const apiKey = config.get<string>('apiKey', '');
  const fallbackModel = config.get<string>('model', '').trim();
  const embeddingModel = config.get<string>('embeddingModel', '').trim();
  const inlineCompletionsModel = config.get<string>('inlineCompletions.model', '').trim();
  return {
    enabled: config.get<boolean>('inlineCompletions.enabled', false),
    fallbackModel,
    backendRouting: resolveBackendRouting({
      baseUrl,
      apiKey,
      model: fallbackModel,
      embeddingModel,
      inlineCompletionsModel,
      backends: config.get<unknown>('backends', {}),
      backendPreset: config.get<unknown>('backendPreset', 'local'),
      backendRouting: config.get<unknown>('backendRouting', {}),
      modelRouting: config.get<unknown>('modelRouting', {}),
    }),
  };
}

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly discoveredModelCache = new Map<string, CachedDiscoveredModel>();

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    const config = readInlineCompletionConfig();
    if (!config.enabled) {
      return [];
    }
    if (token.isCancellationRequested || document.uri.scheme !== 'file') {
      return [];
    }
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
      return [];
    }

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && linePrefix.trim() === '') {
      return [];
    }

    let contextWindow: ReturnType<typeof buildInlineCompletionContext>;
    try {
      contextWindow = buildInlineCompletionContext(document.getText(), document.offsetAt(position));
    } catch {
      return [];
    }
    if (contextWindow.prefix.trim() === '') {
      return [];
    }

    const abortController = new AbortController();
    const cancellation = token.onCancellationRequested(() => abortController.abort());
    try {
      const relativePath = vscode.workspace.asRelativePath(document.uri, false).replaceAll('\\', '/');
      const completionBackends = getBackendsForOperation(config.backendRouting, 'inlineCompletions');
      for (const backend of completionBackends) {
        if (token.isCancellationRequested) {
          return [];
        }
        const client = new OpenAIClient({ baseUrl: backend.baseUrl, apiKey: backend.apiKey });
        const model = await this.resolveModel(client, config, backend, abortController.signal);
        if (model === '') {
          continue;
        }
        try {
          const response = await client.chat(
            {
              model,
              messages: buildInlineCompletionMessages({
                filePath: relativePath,
                languageId: document.languageId,
                prefix: contextWindow.prefix,
                suffix: contextWindow.suffix,
              }),
              temperature: INLINE_COMPLETION_TEMPERATURE,
              signal: abortController.signal,
            },
            () => {
              // Inline completion inserts a single text payload, so we ignore streamed chunks.
            }
          );
          if (token.isCancellationRequested) {
            return [];
          }
          const text = finalizeInlineCompletion(response.content, linePrefix, contextWindow.suffix);
          if (text.trim() === '' || contextWindow.suffix.startsWith(text)) {
            continue;
          }
          return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
        } catch {
          continue;
        }
      }
      return [];
    } catch {
      return [];
    } finally {
      cancellation.dispose();
    }
  }

  private async resolveModel(
    client: OpenAIClient,
    config: InlineCompletionConfig,
    backend: BackendProfile,
    signal: AbortSignal
  ): Promise<string> {
    const explicit = resolveInlineCompletionModel(config.backendRouting, backend, config.fallbackModel);
    if (explicit !== '') {
      return explicit;
    }

    const cacheKey = `${backend.id}\n${backend.baseUrl}\n${backend.apiKey}`;
    const now = Date.now();
    const cached = this.discoveredModelCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      return cached.model;
    }

    const models = await client.listModels(signal);
    const discovered = models[0]?.id ?? '';
    if (discovered !== '') {
      this.discoveredModelCache.set(cacheKey, {
        model: discovered,
        expiresAtMs: now + DISCOVERED_MODEL_TTL_MS,
      });
    }
    return discovered;
  }
}
