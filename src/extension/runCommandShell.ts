/** Shared sentinel protocol for durable agent shell sessions (POSIX + PowerShell). */

export const AGENT_SHELL_SENTINEL = '\u001E';
export const AGENT_SHELL_START_PREFIX = '__BESTIDE_RUN_COMMAND_START__';
export const AGENT_SHELL_END_PREFIX = '__BESTIDE_RUN_COMMAND_END__';
export const AGENT_SHELL_POSIX_FALLBACK = '/bin/sh';

export interface RunCommandShellLaunch {
  command: string;
  args: string[];
  kind: 'posix' | 'powershell';
}

export interface RunCommandScriptTokens {
  command: string;
  startToken: string;
  endTokenPrefix: string;
}

export function buildPosixRunCommandScript(tokens: RunCommandScriptTokens): string {
  const quotedCommand = shellSingleQuote(tokens.command);
  const quotedStartToken = shellSingleQuote(tokens.startToken);
  const quotedEndPrefix = shellSingleQuote(tokens.endTokenPrefix);
  const quotedSentinel = shellSingleQuote(AGENT_SHELL_SENTINEL);
  return [
    `__bestide_run_command=${quotedCommand}`,
    `printf '%s' ${quotedStartToken}`,
    'eval "$__bestide_run_command"',
    '__bestide_run_command_exit_code=$?',
    `printf '%s%s%s' ${quotedEndPrefix} "$__bestide_run_command_exit_code" ${quotedSentinel}`,
    '',
  ].join('\n');
}

export function buildPowerShellRunCommandScript(tokens: RunCommandScriptTokens): string {
  const quotedCommand = powershellSingleQuote(tokens.command);
  const quotedStartToken = powershellSingleQuote(tokens.startToken);
  const quotedEndPrefix = powershellSingleQuote(tokens.endTokenPrefix);
  const quotedSentinel = powershellSingleQuote(AGENT_SHELL_SENTINEL);
  return [
    `$__bestide_run_command = ${quotedCommand}`,
    `[Console]::Out.Write(${quotedStartToken})`,
    'Invoke-Expression $__bestide_run_command',
    'if ($null -ne $LASTEXITCODE) { $__bestide_run_command_exit_code = [int]$LASTEXITCODE } elseif ($?) { $__bestide_run_command_exit_code = 0 } else { $__bestide_run_command_exit_code = 1 }',
    `[Console]::Out.Write((${quotedEndPrefix} + $__bestide_run_command_exit_code.ToString() + ${quotedSentinel}))`,
    '',
  ].join('\n');
}

export function resolveRunCommandShellCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): RunCommandShellLaunch[] {
  if (platform === 'win32') {
    const override = (env['BESTIDE_PWSH'] ?? '').trim();
    const powershellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
    // Default to Windows PowerShell (always present). Prefer pwsh via BESTIDE_PWSH=pwsh.
    return [{ command: override || 'powershell.exe', args: powershellArgs, kind: 'powershell' }];
  }
  const shellPath = (env['SHELL'] ?? '').trim() || AGENT_SHELL_POSIX_FALLBACK;
  return [{ command: shellPath, args: ['-s'], kind: 'posix' }];
}

/** First preferred launch for the platform. */
export function resolveRunCommandShellLaunch(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): RunCommandShellLaunch | undefined {
  return resolveRunCommandShellCandidates(platform, env)[0];
}

export function buildRunCommandScript(
  kind: RunCommandShellLaunch['kind'],
  tokens: RunCommandScriptTokens
): string {
  return kind === 'powershell'
    ? buildPowerShellRunCommandScript(tokens)
    : buildPosixRunCommandScript(tokens);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
