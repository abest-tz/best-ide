interface MetricBucketState {
  count: number;
  successes: number;
  failures: number;
  latencyTotalMs: number;
}

interface TelemetryState {
  version: 1;
  firstEventAt?: number;
  updatedAt?: number;
  runs: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  tools: {
    calls: number;
    successes: number;
    failures: number;
    latencyTotalMs: number;
    byTool: Record<string, MetricBucketState>;
  };
  modelTurns: {
    turns: number;
    failures: number;
    latencyTotalMs: number;
    byBackendModel: Record<string, MetricBucketState>;
  };
  quality: {
    commandApprovalsAccepted: number;
    commandApprovalsRejected: number;
    pendingChangesAccepted: number;
    pendingChangesRejected: number;
  };
}

export interface TelemetryStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ToolTelemetryEvent {
  name: string;
  success: boolean;
  latencyMs: number;
}

export interface ModelTurnTelemetryEvent {
  backendId: string;
  model: string;
  success: boolean;
  latencyMs: number;
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled';

export interface TelemetryMetricSummary {
  count: number;
  successes: number;
  failures: number;
  successRate: number | null;
  averageLatencyMs: number | null;
}

export interface TelemetryNamedMetricSummary extends TelemetryMetricSummary {
  name: string;
}

export interface TelemetrySummary {
  enabled: boolean;
  firstEventAt?: string;
  updatedAt?: string;
  runs: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  tools: TelemetryMetricSummary & {
    byTool: TelemetryNamedMetricSummary[];
  };
  modelTurns: TelemetryMetricSummary & {
    byBackendModel: TelemetryNamedMetricSummary[];
  };
  quality: {
    commandApprovalsAccepted: number;
    commandApprovalsRejected: number;
    commandApprovalRate: number | null;
    pendingChangesAccepted: number;
    pendingChangesRejected: number;
    pendingChangeAcceptanceRate: number | null;
  };
}

const TELEMETRY_STATE_KEY = 'bestIde.telemetry.state';

function createEmptyMetricBucket(): MetricBucketState {
  return {
    count: 0,
    successes: 0,
    failures: 0,
    latencyTotalMs: 0,
  };
}

function createEmptyState(): TelemetryState {
  return {
    version: 1,
    runs: {
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    tools: {
      calls: 0,
      successes: 0,
      failures: 0,
      latencyTotalMs: 0,
      byTool: {},
    },
    modelTurns: {
      turns: 0,
      failures: 0,
      latencyTotalMs: 0,
      byBackendModel: {},
    },
    quality: {
      commandApprovalsAccepted: 0,
      commandApprovalsRejected: 0,
      pendingChangesAccepted: 0,
      pendingChangesRejected: 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toSafeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function toSafeLatency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function normalizeMetricBucket(value: unknown): MetricBucketState {
  if (!isRecord(value)) {
    return createEmptyMetricBucket();
  }
  return {
    count: toSafeCount(value['count']),
    successes: toSafeCount(value['successes']),
    failures: toSafeCount(value['failures']),
    latencyTotalMs: toSafeLatency(value['latencyTotalMs']),
  };
}

function normalizeNamedMetricBuckets(value: unknown): Record<string, MetricBucketState> {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: Record<string, MetricBucketState> = {};
  for (const [name, rawBucket] of Object.entries(value)) {
    const trimmed = name.trim();
    if (trimmed === '') {
      continue;
    }
    normalized[trimmed] = normalizeMetricBucket(rawBucket);
  }
  return normalized;
}

function normalizeState(value: unknown): TelemetryState {
  const empty = createEmptyState();
  if (!isRecord(value) || value['version'] !== 1) {
    return empty;
  }

  const runs = isRecord(value['runs']) ? value['runs'] : {};
  const tools = isRecord(value['tools']) ? value['tools'] : {};
  const modelTurns = isRecord(value['modelTurns']) ? value['modelTurns'] : {};
  const quality = isRecord(value['quality']) ? value['quality'] : {};

  return {
    version: 1,
    ...(typeof value['firstEventAt'] === 'number' && Number.isFinite(value['firstEventAt'])
      ? { firstEventAt: Math.max(0, Math.floor(value['firstEventAt'])) }
      : {}),
    ...(typeof value['updatedAt'] === 'number' && Number.isFinite(value['updatedAt'])
      ? { updatedAt: Math.max(0, Math.floor(value['updatedAt'])) }
      : {}),
    runs: {
      completed: toSafeCount(runs['completed']),
      failed: toSafeCount(runs['failed']),
      cancelled: toSafeCount(runs['cancelled']),
    },
    tools: {
      calls: toSafeCount(tools['calls']),
      successes: toSafeCount(tools['successes']),
      failures: toSafeCount(tools['failures']),
      latencyTotalMs: toSafeLatency(tools['latencyTotalMs']),
      byTool: normalizeNamedMetricBuckets(tools['byTool']),
    },
    modelTurns: {
      turns: toSafeCount(modelTurns['turns']),
      failures: toSafeCount(modelTurns['failures']),
      latencyTotalMs: toSafeLatency(modelTurns['latencyTotalMs']),
      byBackendModel: normalizeNamedMetricBuckets(modelTurns['byBackendModel']),
    },
    quality: {
      commandApprovalsAccepted: toSafeCount(quality['commandApprovalsAccepted']),
      commandApprovalsRejected: toSafeCount(quality['commandApprovalsRejected']),
      pendingChangesAccepted: toSafeCount(quality['pendingChangesAccepted']),
      pendingChangesRejected: toSafeCount(quality['pendingChangesRejected']),
    },
  };
}

function ensureMetricBucket(
  buckets: Record<string, MetricBucketState>,
  name: string
): MetricBucketState | undefined {
  const normalized = name.trim();
  if (normalized === '') {
    return undefined;
  }
  let bucket = buckets[normalized];
  if (!bucket) {
    bucket = createEmptyMetricBucket();
    buckets[normalized] = bucket;
  }
  return bucket;
}

function updateMetricBucket(bucket: MetricBucketState, success: boolean, latencyMs: number): void {
  bucket.count += 1;
  if (success) {
    bucket.successes += 1;
  } else {
    bucket.failures += 1;
  }
  bucket.latencyTotalMs += toSafeLatency(latencyMs);
}

function average(total: number, count: number): number | null {
  if (count <= 0) {
    return null;
  }
  return Math.round(total / count);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

function toMetricSummary(bucket: MetricBucketState): TelemetryMetricSummary {
  return {
    count: bucket.count,
    successes: bucket.successes,
    failures: bucket.failures,
    successRate: rate(bucket.successes, bucket.count),
    averageLatencyMs: average(bucket.latencyTotalMs, bucket.count),
  };
}

function summarizeNamedBuckets(
  buckets: Record<string, MetricBucketState>
): TelemetryNamedMetricSummary[] {
  return Object.entries(buckets)
    .map(([name, bucket]) => ({
      name,
      ...toMetricSummary(bucket),
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function toIsoDate(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function formatPercentage(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? 'n/a' : `${value} ms`;
}

function formatNamedMetrics(
  title: string,
  entries: TelemetryNamedMetricSummary[],
  emptyText: string
): string[] {
  if (entries.length === 0) {
    return [`${title}: ${emptyText}`];
  }
  return [
    `${title}:`,
    ...entries.map(
      (entry) =>
        `- ${entry.name}: ${entry.count} call(s), ${formatPercentage(entry.successRate)} success, avg ${formatLatency(entry.averageLatencyMs)}`
    ),
  ];
}

export function buildTelemetrySummary(state: TelemetryState, enabled: boolean): TelemetrySummary {
  const toolSummary = toMetricSummary({
    count: state.tools.calls,
    successes: state.tools.successes,
    failures: state.tools.failures,
    latencyTotalMs: state.tools.latencyTotalMs,
  });
  const modelTurnSuccesses = Math.max(0, state.modelTurns.turns - state.modelTurns.failures);
  const modelSummary = toMetricSummary({
    count: state.modelTurns.turns,
    successes: modelTurnSuccesses,
    failures: state.modelTurns.failures,
    latencyTotalMs: state.modelTurns.latencyTotalMs,
  });
  const approvalTotal =
    state.quality.commandApprovalsAccepted + state.quality.commandApprovalsRejected;
  const pendingChangeTotal =
    state.quality.pendingChangesAccepted + state.quality.pendingChangesRejected;

  return {
    enabled,
    ...(state.firstEventAt !== undefined ? { firstEventAt: toIsoDate(state.firstEventAt) } : {}),
    ...(state.updatedAt !== undefined ? { updatedAt: toIsoDate(state.updatedAt) } : {}),
    runs: { ...state.runs },
    tools: {
      ...toolSummary,
      byTool: summarizeNamedBuckets(state.tools.byTool),
    },
    modelTurns: {
      ...modelSummary,
      byBackendModel: summarizeNamedBuckets(state.modelTurns.byBackendModel),
    },
    quality: {
      commandApprovalsAccepted: state.quality.commandApprovalsAccepted,
      commandApprovalsRejected: state.quality.commandApprovalsRejected,
      commandApprovalRate: rate(state.quality.commandApprovalsAccepted, approvalTotal),
      pendingChangesAccepted: state.quality.pendingChangesAccepted,
      pendingChangesRejected: state.quality.pendingChangesRejected,
      pendingChangeAcceptanceRate: rate(state.quality.pendingChangesAccepted, pendingChangeTotal),
    },
  };
}

export function formatTelemetrySummary(summary: TelemetrySummary): string {
  const lines = [
    '# Best IDE telemetry summary',
    '',
    `Telemetry enabled: ${summary.enabled ? 'yes' : 'no'}`,
    `First event: ${summary.firstEventAt ?? 'n/a'}`,
    `Last updated: ${summary.updatedAt ?? 'n/a'}`,
    '',
    '## Runs',
    `- completed: ${summary.runs.completed}`,
    `- failed: ${summary.runs.failed}`,
    `- cancelled: ${summary.runs.cancelled}`,
    '',
    '## Tool calls',
    `- total calls: ${summary.tools.count}`,
    `- success rate: ${formatPercentage(summary.tools.successRate)}`,
    `- average latency: ${formatLatency(summary.tools.averageLatencyMs)}`,
    '',
    '## Model turns',
    `- total turns: ${summary.modelTurns.count}`,
    `- success rate: ${formatPercentage(summary.modelTurns.successRate)}`,
    `- average latency: ${formatLatency(summary.modelTurns.averageLatencyMs)}`,
    '',
    '## Quality signals',
    `- command approvals accepted: ${summary.quality.commandApprovalsAccepted}`,
    `- command approvals rejected: ${summary.quality.commandApprovalsRejected}`,
    `- command approval rate: ${formatPercentage(summary.quality.commandApprovalRate)}`,
    `- pending changes accepted: ${summary.quality.pendingChangesAccepted}`,
    `- pending changes rejected: ${summary.quality.pendingChangesRejected}`,
    `- pending change acceptance rate: ${formatPercentage(summary.quality.pendingChangeAcceptanceRate)}`,
    '',
    ...formatNamedMetrics('Top tools', summary.tools.byTool, '(no tool telemetry yet)'),
    '',
    ...formatNamedMetrics(
      'Model backends',
      summary.modelTurns.byBackendModel,
      '(no model telemetry yet)'
    ),
  ];
  return lines.join('\n');
}

export class TelemetryRecorder {
  private readonly store: TelemetryStore;
  private state: TelemetryState;
  private enabled: boolean;

  constructor(store: TelemetryStore, options: { enabled: boolean }) {
    this.store = store;
    this.enabled = options.enabled;
    this.state = normalizeState(this.store.get<TelemetryState>(TELEMETRY_STATE_KEY));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getSummary(): TelemetrySummary {
    return buildTelemetrySummary(this.state, this.enabled);
  }

  recordRunOutcome(outcome: RunOutcome): void {
    if (!this.enabled) {
      return;
    }
    if (outcome === 'completed') {
      this.state.runs.completed += 1;
    } else if (outcome === 'failed') {
      this.state.runs.failed += 1;
    } else {
      this.state.runs.cancelled += 1;
    }
    this.touchAndPersist();
  }

  recordToolCall(event: ToolTelemetryEvent): void {
    if (!this.enabled) {
      return;
    }
    this.state.tools.calls += 1;
    if (event.success) {
      this.state.tools.successes += 1;
    } else {
      this.state.tools.failures += 1;
    }
    this.state.tools.latencyTotalMs += toSafeLatency(event.latencyMs);
    const bucket = ensureMetricBucket(this.state.tools.byTool, event.name);
    if (bucket) {
      updateMetricBucket(bucket, event.success, event.latencyMs);
    }
    this.touchAndPersist();
  }

  recordModelTurn(event: ModelTurnTelemetryEvent): void {
    if (!this.enabled) {
      return;
    }
    this.state.modelTurns.turns += 1;
    if (!event.success) {
      this.state.modelTurns.failures += 1;
    }
    this.state.modelTurns.latencyTotalMs += toSafeLatency(event.latencyMs);
    const backendLabel = event.backendId.trim() || 'unknown-backend';
    const modelLabel = event.model.trim() || 'unknown-model';
    const bucket = ensureMetricBucket(
      this.state.modelTurns.byBackendModel,
      `${backendLabel} / ${modelLabel}`
    );
    if (bucket) {
      updateMetricBucket(bucket, event.success, event.latencyMs);
    }
    this.touchAndPersist();
  }

  recordCommandApproval(approved: boolean): void {
    if (!this.enabled) {
      return;
    }
    if (approved) {
      this.state.quality.commandApprovalsAccepted += 1;
    } else {
      this.state.quality.commandApprovalsRejected += 1;
    }
    this.touchAndPersist();
  }

  recordPendingChangeDecision(accepted: boolean): void {
    if (!this.enabled) {
      return;
    }
    if (accepted) {
      this.state.quality.pendingChangesAccepted += 1;
    } else {
      this.state.quality.pendingChangesRejected += 1;
    }
    this.touchAndPersist();
  }

  async reset(): Promise<void> {
    this.state = createEmptyState();
    await this.store.update(TELEMETRY_STATE_KEY, this.state);
  }

  private touchAndPersist(): void {
    const now = Date.now();
    if (this.state.firstEventAt === undefined) {
      this.state.firstEventAt = now;
    }
    this.state.updatedAt = now;
    void this.store.update(TELEMETRY_STATE_KEY, this.state).then(
      () => undefined,
      () => undefined
    );
  }
}
