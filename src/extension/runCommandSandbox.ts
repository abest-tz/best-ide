import * as path from 'node:path';

const RUN_COMMAND_TIMEOUT_MIN_MS = 100;
const RUN_COMMAND_TIMEOUT_UPPER_BOUND_MS = 10 * 60_000;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const RUN_COMMAND_TIMEOUT_DEFAULT_MS = 60_000;
export const RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS = 5 * 60_000;

export interface RunCommandTimeoutPolicy {
  timeoutMs: number;
  maxTimeoutMs: number;
}

export interface RunCommandSandboxSettings extends RunCommandTimeoutPolicy {
  cwd?: string;
  env: Record<string, string>;
  inheritEnv: boolean;
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return Math.min(RUN_COMMAND_TIMEOUT_UPPER_BOUND_MS, Math.max(RUN_COMMAND_TIMEOUT_MIN_MS, normalized));
}

export function normalizeRunCommandCwd(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

export function normalizeRunCommandEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || key.trim() === '' || !ENV_VAR_NAME_PATTERN.test(key)) {
      continue;
    }
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

export function normalizeRunCommandSandboxSettings(input: {
  cwd?: unknown;
  env?: unknown;
  inheritEnv?: unknown;
  timeoutMs?: unknown;
  maxTimeoutMs?: unknown;
}): RunCommandSandboxSettings {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs, RUN_COMMAND_TIMEOUT_DEFAULT_MS);
  const normalizedMaxTimeoutMs = normalizeTimeoutMs(input.maxTimeoutMs, RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS);
  return {
    cwd: normalizeRunCommandCwd(input.cwd),
    env: normalizeRunCommandEnv(input.env),
    inheritEnv: typeof input.inheritEnv === 'boolean' ? input.inheritEnv : true,
    timeoutMs,
    maxTimeoutMs: Math.max(timeoutMs, normalizedMaxTimeoutMs),
  };
}

export function resolveSandboxCwd(workspaceRootPath: string, configuredCwd?: string): string {
  const resolved = configuredCwd
    ? path.isAbsolute(configuredCwd)
      ? path.resolve(configuredCwd)
      : path.resolve(workspaceRootPath, configuredCwd)
    : workspaceRootPath;
  const relative = path.relative(workspaceRootPath, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error('bestIde.runCommand.cwd must resolve inside the workspace root');
}

export function resolveCommandTimeoutMs(
  requestedTimeoutMs: number | undefined,
  policy: RunCommandTimeoutPolicy
): number {
  const normalizedRequested =
    typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.floor(requestedTimeoutMs)
      : policy.timeoutMs;
  return Math.min(policy.maxTimeoutMs, Math.max(RUN_COMMAND_TIMEOUT_MIN_MS, normalizedRequested));
}
