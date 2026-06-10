import { describe, expect, it } from 'vitest';
import {
  buildComposerExecutionPrompt,
  buildComposerPlanMessages,
  formatComposerPlan,
  parseComposerPlan,
} from '../src/extension/composerMode';

describe('buildComposerPlanMessages', () => {
  it('builds planner system and user messages', () => {
    const messages = buildComposerPlanMessages('Refactor auth and update tests.');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('Refactor auth and update tests.');
  });
});

describe('parseComposerPlan', () => {
  it('parses valid JSON responses', () => {
    const plan = parseComposerPlan(
      JSON.stringify({
        objective: 'Refactor auth flow',
        steps: [
          { id: '1', description: 'Update auth service logic.', files: ['src/auth/service.ts'] },
          { id: '2', description: 'Add regression tests.', files: ['tests/auth.test.ts'] },
        ],
        files: [
          { path: 'src/auth/service.ts', reason: 'Behavior change.' },
          { path: 'tests/auth.test.ts', reason: 'Coverage for new flow.' },
        ],
      }),
      'Refactor auth flow'
    );

    expect(plan.objective).toBe('Refactor auth flow');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.files).toEqual(['src/auth/service.ts']);
    expect(plan.files[1]?.path).toBe('tests/auth.test.ts');
  });

  it('extracts and parses fenced JSON responses', () => {
    const plan = parseComposerPlan(
      [
        'Here is the plan:',
        '```json',
        JSON.stringify({
          objective: 'Improve inline completions',
          steps: [{ description: 'Tune completion prompt.', files: ['src/extension/tabCompletion.ts'] }],
          files: ['src/extension/tabCompletion.ts'],
        }),
        '```',
      ].join('\n'),
      'Improve inline completions'
    );

    expect(plan.objective).toBe('Improve inline completions');
    expect(plan.steps[0]?.description).toMatch(/Tune completion prompt/i);
    expect(plan.files[0]?.path).toBe('src/extension/tabCompletion.ts');
  });

  it('falls back to a structured bullet-derived plan when JSON is invalid', () => {
    const plan = parseComposerPlan(
      ['1. Update `src/core/agent.ts` to support retries', '2. Add tests in `tests/agent.test.ts`'].join(
        '\n'
      ),
      'Support retries'
    );

    expect(plan.steps).toHaveLength(2);
    expect(plan.files.map((file) => file.path)).toEqual([
      'src/core/agent.ts',
      'tests/agent.test.ts',
    ]);
  });

  it('returns a default structured plan for unstructured text', () => {
    const plan = parseComposerPlan('sounds good, go ahead', 'Harden run command flow');
    expect(plan.objective).toBe('Harden run command flow');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.description).toMatch(/Investigate/i);
  });
});

describe('composer plan formatting', () => {
  it('formats plan text and execution prompt', () => {
    const plan = parseComposerPlan(
      JSON.stringify({
        objective: 'Add command sandbox',
        steps: [{ id: '1', description: 'Introduce timeout policy.', files: ['src/extension/host.ts'] }],
        files: [{ path: 'src/extension/host.ts', reason: 'Command execution policy.' }],
      }),
      'Add command sandbox'
    );

    const formatted = formatComposerPlan(plan);
    expect(formatted).toContain('Objective: Add command sandbox');
    expect(formatted).toContain('1. Introduce timeout policy.');
    expect(formatted).toContain('src/extension/host.ts');

    const executionPrompt = buildComposerExecutionPrompt('Implement sandboxing', plan);
    expect(executionPrompt).toContain('"objective": "Add command sandbox"');
    expect(executionPrompt).toContain('[Task]');
    expect(executionPrompt).toContain('Implement sandboxing');
  });
});
