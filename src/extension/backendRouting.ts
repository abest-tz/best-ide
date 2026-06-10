import type { ChatMode } from '../shared/protocol';

export type BackendRole = 'local' | 'cost' | 'quality' | 'general';
export type BackendPreset = 'local' | 'cost' | 'quality';
export type BackendOperation = 'chat' | 'models' | 'embeddings' | 'inlineCompletions';

export interface BackendProfile {
  id: string;
  baseUrl: string;
  apiKey: string;
  role: BackendRole;
  model: string;
  embeddingModel: string;
  inlineCompletionsModel: string;
  chatModels: {
    agent: string;
    ask: string;
    composer: string;
  };
}

export interface ModelRouting {
  agent: string;
  ask: string;
  composer: string;
  embeddings: string;
  inlineCompletions: string;
}

export interface BackendRoutingState {
  preset: BackendPreset;
  backends: BackendProfile[];
  routes: Record<BackendOperation, string[]>;
  modelRouting: ModelRouting;
}

export interface ResolveBackendRoutingInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
  inlineCompletionsModel: string;
  backends: unknown;
  backendPreset: unknown;
  backendRouting: unknown;
  modelRouting: unknown;
}

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';

const PRESET_ROLE_PRIORITY: Record<BackendPreset, readonly BackendRole[]> = {
  local: ['local', 'cost', 'general', 'quality'],
  cost: ['cost', 'local', 'general', 'quality'],
  quality: ['quality', 'cost', 'general', 'local'],
};

interface ParsedBackendEntry {
  id: string;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  role: BackendRole;
  model: string;
  embeddingModel: string;
  inlineCompletionsModel: string;
  chatModels: {
    agent: string;
    ask: string;
    composer: string;
  };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeBackendRole(value: unknown, fallback: BackendRole): BackendRole {
  if (value === 'local' || value === 'cost' || value === 'quality' || value === 'general') {
    return value;
  }
  return fallback;
}

function normalizeBackendPreset(value: unknown): BackendPreset {
  if (value === 'cost' || value === 'quality') {
    return value;
  }
  return 'local';
}

function parseModelRouting(value: unknown): ModelRouting {
  const record = asRecord(value);
  return {
    agent: normalizeString(record?.['agent']),
    ask: normalizeString(record?.['ask']),
    composer: normalizeString(record?.['composer']),
    embeddings: normalizeString(record?.['embeddings']),
    inlineCompletions: normalizeString(record?.['inlineCompletions']),
  };
}

function parseBackendEntries(value: unknown): ParsedBackendEntry[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const entries: ParsedBackendEntry[] = [];
  for (const [rawId, rawEntry] of Object.entries(record)) {
    const id = rawId.trim();
    const entryRecord = asRecord(rawEntry);
    if (id === '' || !entryRecord) {
      continue;
    }
    const modelsRecord = asRecord(entryRecord['models']);
    entries.push({
      id,
      enabled: entryRecord['enabled'] !== false,
      baseUrl: normalizeString(entryRecord['baseUrl']),
      apiKey: normalizeString(entryRecord['apiKey']),
      role: normalizeBackendRole(entryRecord['role'], id === 'local' ? 'local' : 'general'),
      model: normalizeString(entryRecord['model']) || normalizeString(modelsRecord?.['default']),
      embeddingModel:
        normalizeString(entryRecord['embeddingModel']) || normalizeString(modelsRecord?.['embeddings']),
      inlineCompletionsModel:
        normalizeString(entryRecord['inlineCompletionsModel']) ||
        normalizeString(modelsRecord?.['inlineCompletions']),
      chatModels: {
        agent: normalizeString(modelsRecord?.['agent']) || normalizeString(entryRecord['agentModel']),
        ask: normalizeString(modelsRecord?.['ask']) || normalizeString(entryRecord['askModel']),
        composer:
          normalizeString(modelsRecord?.['composer']) || normalizeString(entryRecord['composerModel']),
      },
    });
  }
  return entries;
}

function createLocalBackend(input: ResolveBackendRoutingInput): BackendProfile {
  const configuredBaseUrl = normalizeString(input.baseUrl);
  return {
    id: 'local',
    baseUrl: configuredBaseUrl || DEFAULT_BASE_URL,
    apiKey: normalizeString(input.apiKey),
    role: 'local',
    model: normalizeString(input.model),
    embeddingModel: normalizeString(input.embeddingModel),
    inlineCompletionsModel: normalizeString(input.inlineCompletionsModel),
    chatModels: {
      agent: '',
      ask: '',
      composer: '',
    },
  };
}

function mergeBackend(base: BackendProfile, override: ParsedBackendEntry): BackendProfile {
  return {
    ...base,
    ...(override.baseUrl !== '' ? { baseUrl: override.baseUrl } : {}),
    ...(override.apiKey !== '' ? { apiKey: override.apiKey } : {}),
    role: override.role,
    ...(override.model !== '' ? { model: override.model } : {}),
    ...(override.embeddingModel !== '' ? { embeddingModel: override.embeddingModel } : {}),
    ...(override.inlineCompletionsModel !== ''
      ? { inlineCompletionsModel: override.inlineCompletionsModel }
      : {}),
    chatModels: {
      agent: override.chatModels.agent || base.chatModels.agent,
      ask: override.chatModels.ask || base.chatModels.ask,
      composer: override.chatModels.composer || base.chatModels.composer,
    },
  };
}

function sortByPreset(backends: BackendProfile[], preset: BackendPreset): BackendProfile[] {
  const rolePriority = PRESET_ROLE_PRIORITY[preset];
  const roleOrder = new Map<BackendRole, number>(rolePriority.map((role, index) => [role, index]));
  const insertionOrder = new Map<string, number>(backends.map((backend, index) => [backend.id, index]));
  return [...backends].sort((left, right) => {
    const leftPriority = roleOrder.get(left.role) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = roleOrder.get(right.role) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return (insertionOrder.get(left.id) ?? 0) - (insertionOrder.get(right.id) ?? 0);
  });
}

function normalizeRouteOverride(value: unknown, availableBackendIds: Set<string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const route: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const backendId = entry.trim();
    if (backendId === '' || !availableBackendIds.has(backendId) || route.includes(backendId)) {
      continue;
    }
    route.push(backendId);
  }
  return route;
}

export function resolveBackendRouting(input: ResolveBackendRoutingInput): BackendRoutingState {
  const preset = normalizeBackendPreset(input.backendPreset);
  const localBackend = createLocalBackend(input);
  const configuredBackends = parseBackendEntries(input.backends);

  const orderedBackends: BackendProfile[] = [];
  let includeLocalBackend = true;
  let mergedLocalBackend = localBackend;

  for (const backend of configuredBackends) {
    if (backend.id === 'local') {
      if (!backend.enabled) {
        includeLocalBackend = false;
        continue;
      }
      mergedLocalBackend = mergeBackend(localBackend, backend);
      continue;
    }
    if (!backend.enabled || backend.baseUrl === '') {
      continue;
    }
    orderedBackends.push({
      id: backend.id,
      baseUrl: backend.baseUrl,
      apiKey: backend.apiKey,
      role: backend.role,
      model: backend.model,
      embeddingModel: backend.embeddingModel,
      inlineCompletionsModel: backend.inlineCompletionsModel,
      chatModels: backend.chatModels,
    });
  }

  const backends: BackendProfile[] = [];
  if (includeLocalBackend) {
    backends.push(mergedLocalBackend);
  }
  backends.push(...orderedBackends);
  if (backends.length === 0) {
    backends.push(localBackend);
  }

  const presetOrder = sortByPreset(backends, preset).map((backend) => backend.id);
  const availableBackendIds = new Set(backends.map((backend) => backend.id));
  const routeConfig = asRecord(input.backendRouting);
  const chatRoute = normalizeRouteOverride(routeConfig?.['chat'], availableBackendIds);

  const chat = chatRoute.length > 0 ? chatRoute : presetOrder;
  const models = normalizeRouteOverride(routeConfig?.['models'], availableBackendIds);
  const embeddings = normalizeRouteOverride(routeConfig?.['embeddings'], availableBackendIds);
  const inlineCompletions = normalizeRouteOverride(
    routeConfig?.['inlineCompletions'],
    availableBackendIds
  );

  return {
    preset,
    backends,
    routes: {
      chat,
      models: models.length > 0 ? models : chat,
      embeddings: embeddings.length > 0 ? embeddings : chat,
      inlineCompletions: inlineCompletions.length > 0 ? inlineCompletions : chat,
    },
    modelRouting: parseModelRouting(input.modelRouting),
  };
}

export function getBackendsForOperation(
  state: BackendRoutingState,
  operation: BackendOperation
): BackendProfile[] {
  const byId = new Map(state.backends.map((backend) => [backend.id, backend] as const));
  const ordered = state.routes[operation]
    .map((backendId) => byId.get(backendId))
    .filter((backend): backend is BackendProfile => backend !== undefined);
  return ordered.length > 0 ? ordered : state.backends;
}

export function resolveChatModel(
  state: BackendRoutingState,
  backend: BackendProfile,
  mode: ChatMode,
  selectedModel: string
): string {
  const selected = selectedModel.trim();
  const modeOverride =
    mode === 'ask'
      ? state.modelRouting.ask
      : mode === 'composer'
        ? state.modelRouting.composer
        : state.modelRouting.agent;
  const backendModeModel =
    mode === 'ask'
      ? backend.chatModels.ask
      : mode === 'composer'
        ? backend.chatModels.composer
        : backend.chatModels.agent;
  return modeOverride || backendModeModel || selected || backend.model;
}

export function resolveEmbeddingModel(state: BackendRoutingState, backend: BackendProfile): string {
  return state.modelRouting.embeddings || backend.embeddingModel;
}

export function resolveInlineCompletionModel(
  state: BackendRoutingState,
  backend: BackendProfile,
  fallbackModel: string
): string {
  const fallback = fallbackModel.trim();
  return state.modelRouting.inlineCompletions || backend.inlineCompletionsModel || fallback || backend.model;
}
