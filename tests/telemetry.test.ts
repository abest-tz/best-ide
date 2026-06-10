import { describe, expect, it } from 'vitest';
import { TelemetryRecorder, type TelemetryStore } from '../src/extension/telemetry';

class MemoryTelemetryStore implements TelemetryStore {
  private readonly values = new Map<string, unknown>();
  public updates = 0;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updates += 1;
    this.values.set(key, value);
  }
}

describe('TelemetryRecorder', () => {
  it('ignores events while telemetry is disabled', () => {
    const store = new MemoryTelemetryStore();
    const telemetry = new TelemetryRecorder(store, { enabled: false });

    telemetry.recordRunOutcome('completed');
    telemetry.recordToolCall({ name: 'read_file', success: true, latencyMs: 12 });
    telemetry.recordModelTurn({ backendId: 'local', model: 'qwen', success: true, latencyMs: 90 });
    telemetry.recordCommandApproval(true);
    telemetry.recordPendingChangeDecision(true);

    const summary = telemetry.getSummary();
    expect(summary.enabled).toBe(false);
    expect(summary.runs).toEqual({ completed: 0, failed: 0, cancelled: 0 });
    expect(summary.tools.count).toBe(0);
    expect(summary.modelTurns.count).toBe(0);
    expect(summary.quality.commandApprovalsAccepted).toBe(0);
    expect(summary.quality.pendingChangesAccepted).toBe(0);
    expect(store.updates).toBe(0);
  });

  it('records tool/model quality metrics when enabled', () => {
    const store = new MemoryTelemetryStore();
    const telemetry = new TelemetryRecorder(store, { enabled: true });

    telemetry.recordRunOutcome('completed');
    telemetry.recordRunOutcome('failed');
    telemetry.recordRunOutcome('cancelled');

    telemetry.recordToolCall({ name: 'read_file', success: true, latencyMs: 10 });
    telemetry.recordToolCall({ name: 'read_file', success: true, latencyMs: 20 });
    telemetry.recordToolCall({ name: 'run_command', success: false, latencyMs: 50 });

    telemetry.recordModelTurn({ backendId: 'local', model: 'qwen', success: true, latencyMs: 100 });
    telemetry.recordModelTurn({ backendId: 'local', model: 'qwen', success: false, latencyMs: 300 });
    telemetry.recordModelTurn({ backendId: 'cloud', model: 'gpt-4.1', success: true, latencyMs: 200 });

    telemetry.recordCommandApproval(true);
    telemetry.recordCommandApproval(false);
    telemetry.recordPendingChangeDecision(true);
    telemetry.recordPendingChangeDecision(true);
    telemetry.recordPendingChangeDecision(false);

    const summary = telemetry.getSummary();
    expect(summary.enabled).toBe(true);
    expect(summary.runs).toEqual({ completed: 1, failed: 1, cancelled: 1 });

    expect(summary.tools.count).toBe(3);
    expect(summary.tools.successes).toBe(2);
    expect(summary.tools.failures).toBe(1);
    expect(summary.tools.successRate).toBeCloseTo(2 / 3, 5);
    expect(summary.tools.averageLatencyMs).toBe(27);
    expect(summary.tools.byTool[0]).toMatchObject({
      name: 'read_file',
      count: 2,
      successes: 2,
      failures: 0,
    });
    expect(summary.tools.byTool[1]).toMatchObject({
      name: 'run_command',
      count: 1,
      successes: 0,
      failures: 1,
    });

    expect(summary.modelTurns.count).toBe(3);
    expect(summary.modelTurns.successes).toBe(2);
    expect(summary.modelTurns.failures).toBe(1);
    expect(summary.modelTurns.successRate).toBeCloseTo(2 / 3, 5);
    expect(summary.modelTurns.averageLatencyMs).toBe(200);
    expect(summary.modelTurns.byBackendModel).toHaveLength(2);
    expect(summary.modelTurns.byBackendModel[0]).toMatchObject({
      name: 'local / qwen',
      count: 2,
      successes: 1,
      failures: 1,
      averageLatencyMs: 200,
    });

    expect(summary.quality).toMatchObject({
      commandApprovalsAccepted: 1,
      commandApprovalsRejected: 1,
      pendingChangesAccepted: 2,
      pendingChangesRejected: 1,
    });
    expect(summary.quality.commandApprovalRate).toBeCloseTo(0.5, 5);
    expect(summary.quality.pendingChangeAcceptanceRate).toBeCloseTo(2 / 3, 5);
    expect(summary.firstEventAt).toBeDefined();
    expect(summary.updatedAt).toBeDefined();
  });

  it('persists and resets telemetry state', async () => {
    const store = new MemoryTelemetryStore();
    const first = new TelemetryRecorder(store, { enabled: true });
    first.recordToolCall({ name: 'grep', success: true, latencyMs: 15 });

    const restored = new TelemetryRecorder(store, { enabled: true });
    expect(restored.getSummary().tools.count).toBe(1);

    await restored.reset();
    const afterReset = restored.getSummary();
    expect(afterReset.tools.count).toBe(0);
    expect(afterReset.modelTurns.count).toBe(0);
    expect(afterReset.runs).toEqual({ completed: 0, failed: 0, cancelled: 0 });
    expect(afterReset.quality.pendingChangesAccepted).toBe(0);
  });
});
