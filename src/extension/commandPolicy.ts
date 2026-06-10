import * as path from 'node:path';

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const SEGMENT_SEPARATORS = new Set(['&&', '||', '|', ';']);
const WRAPPER_COMMANDS = new Set(['env', 'command', 'builtin', 'nohup', 'time']);

export interface CommandPolicy {
  allowlist: readonly string[];
  denylist: readonly string[];
}

export interface CommandPolicyDecision {
  allowed: boolean;
  executable?: string;
  executables: string[];
  reason?: string;
}

function isSegmentSeparator(token: string): boolean {
  return SEGMENT_SEPARATORS.has(token);
}

function normalizeExecutableToken(token: string): string {
  const base = path.basename(token.trim());
  return process.platform === 'win32' ? base.toLowerCase() : base;
}

function normalizePolicyEntries(entries: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const entry of entries) {
    const raw = entry.trim();
    if (raw === '') {
      continue;
    }
    const firstToken = extractCommandExecutables(raw)[0] ?? raw;
    const resolved = normalizeExecutableToken(firstToken);
    if (resolved !== '') {
      normalized.add(resolved);
    }
  }
  return normalized;
}

export function tokenizeCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;

  const pushCurrent = (): void => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    const next = commandLine[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === '\\' && quote !== "'") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === '&' && next === '&') {
      pushCurrent();
      tokens.push('&&');
      index += 1;
      continue;
    }

    if (char === '|' && next === '|') {
      pushCurrent();
      tokens.push('||');
      index += 1;
      continue;
    }

    if (char === '|' || char === ';') {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }
  pushCurrent();
  return tokens;
}

export function extractCommandExecutables(commandLine: string): string[] {
  const tokens = tokenizeCommand(commandLine);
  const executables: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    while (index < tokens.length && isSegmentSeparator(tokens[index]!)) {
      index += 1;
    }
    while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index]!)) {
      index += 1;
    }
    if (index >= tokens.length) {
      break;
    }

    let candidate = tokens[index]!;
    if (isSegmentSeparator(candidate)) {
      index += 1;
      continue;
    }

    if (WRAPPER_COMMANDS.has(candidate)) {
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (isSegmentSeparator(token)) {
          break;
        }
        if (ENV_ASSIGNMENT_PATTERN.test(token) || token.startsWith('-')) {
          index += 1;
          continue;
        }
        candidate = token;
        break;
      }
      if (index >= tokens.length || isSegmentSeparator(tokens[index]!)) {
        break;
      }
    }

    executables.push(candidate);
    while (index < tokens.length && !isSegmentSeparator(tokens[index]!)) {
      index += 1;
    }
  }

  return executables;
}

export function evaluateCommandPolicy(commandLine: string, policy: CommandPolicy): CommandPolicyDecision {
  const executables = extractCommandExecutables(commandLine);
  if (executables.length === 0) {
    return {
      allowed: false,
      executables,
      reason: 'command is empty or could not be parsed',
    };
  }

  const allowlist = normalizePolicyEntries(policy.allowlist);
  const denylist = normalizePolicyEntries(policy.denylist);

  for (const executable of executables) {
    const normalized = normalizeExecutableToken(executable);
    if (denylist.has(normalized)) {
      return {
        allowed: false,
        executable,
        executables,
        reason: `command "${executable}" is blocked by bestIde.runCommand.denylist`,
      };
    }
  }

  if (allowlist.size > 0) {
    for (const executable of executables) {
      const normalized = normalizeExecutableToken(executable);
      if (!allowlist.has(normalized)) {
        return {
          allowed: false,
          executable,
          executables,
          reason: `command "${executable}" is not included in bestIde.runCommand.allowlist`,
        };
      }
    }
  }

  return {
    allowed: true,
    executable: executables[0],
    executables,
  };
}
