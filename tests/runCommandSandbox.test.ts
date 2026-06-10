import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUN_COMMAND_TIMEOUT_DEFAULT_MS,
  RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS,
  normalizeRunCommandSandboxSettings,
  resolveCommandTimeoutMs,
  resolveSandboxCwd,
} from '../src/extension/runCommandSandbox';

describe('normalizeRunCommandSandboxSettings', () => {
  it('falls back to defaults for invalid configuration values', () => {
    const settings = normalizeRunCommandSandboxSettings({
      cwd: 123,
      env: ['TOKEN=abc'],
      inheritEnv: 'yes',
      timeoutMs: 'bad',
      maxTimeoutMs: 'bad',
    });

    expect(settings).toEqual({
      cwd: undefined,
      env: {},
      inheritEnv: true,
      timeoutMs: RUN_COMMAND_TIMEOUT_DEFAULT_MS,
      maxTimeoutMs: RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS,
    });
  });

  it('normalizes cwd, env, and timeout values', () => {
    const settings = normalizeRunCommandSandboxSettings({
      cwd: ' scripts ',
      env: {
        API_TOKEN: 'token',
        PATH: '/usr/bin',
        DEBUG: true,
      },
      inheritEnv: false,
      timeoutMs: 5_500.9,
      maxTimeoutMs: 9_000.1,
    });

    expect(settings).toEqual({
      cwd: 'scripts',
      env: {
        API_TOKEN: 'token',
        PATH: '/usr/bin',
      },
      inheritEnv: false,
      timeoutMs: 5_500,
      maxTimeoutMs: 9_000,
    });
  });

  it('keeps max timeout at least as large as default timeout', () => {
    const settings = normalizeRunCommandSandboxSettings({
      timeoutMs: 20_000,
      maxTimeoutMs: 5_000,
    });

    expect(settings.timeoutMs).toBe(20_000);
    expect(settings.maxTimeoutMs).toBe(20_000);
  });
});

describe('resolveSandboxCwd', () => {
  const workspaceRoot = path.resolve('/tmp/best-ide-workspace');

  it('returns the workspace root when cwd is not configured', () => {
    expect(resolveSandboxCwd(workspaceRoot, undefined)).toBe(workspaceRoot);
  });

  it('resolves relative cwd within the workspace root', () => {
    expect(resolveSandboxCwd(workspaceRoot, 'packages/app')).toBe(
      path.resolve(workspaceRoot, 'packages/app')
    );
  });

  it('rejects cwd values that escape the workspace root', () => {
    expect(() => resolveSandboxCwd(workspaceRoot, '../outside')).toThrow(/workspace root/i);
  });
});

describe('resolveCommandTimeoutMs', () => {
  it('uses the configured default timeout when no timeout is requested', () => {
    expect(resolveCommandTimeoutMs(undefined, { timeoutMs: 12_000, maxTimeoutMs: 30_000 })).toBe(12_000);
  });

  it('clamps requested timeouts to the configured max timeout', () => {
    expect(resolveCommandTimeoutMs(120_000, { timeoutMs: 12_000, maxTimeoutMs: 30_000 })).toBe(30_000);
  });

  it('falls back to default timeout when the request is invalid', () => {
    expect(resolveCommandTimeoutMs(0, { timeoutMs: 12_000, maxTimeoutMs: 30_000 })).toBe(12_000);
  });
});
