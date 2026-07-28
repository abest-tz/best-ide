import { describe, expect, it } from 'vitest';
import {
  AGENT_SHELL_SENTINEL,
  buildPosixRunCommandScript,
  buildPowerShellRunCommandScript,
  buildRunCommandScript,
  resolveRunCommandShellLaunch,
} from '../src/extension/runCommandShell';

describe('runCommandShell script builders', () => {
  const tokens = {
    command: "echo 'hi'",
    startToken: `${AGENT_SHELL_SENTINEL}__BESTIDE_RUN_COMMAND_START__1${AGENT_SHELL_SENTINEL}`,
    endTokenPrefix: `${AGENT_SHELL_SENTINEL}__BESTIDE_RUN_COMMAND_END__1:`,
  };

  it('builds a POSIX sentinel script', () => {
    const script = buildPosixRunCommandScript(tokens);
    expect(script).toContain("printf '%s'");
    expect(script).toContain('eval "$__bestide_run_command"');
    expect(script).toContain(tokens.startToken.replace(/'/g, `'\"'\"'`));
  });

  it('builds a PowerShell sentinel script', () => {
    const script = buildPowerShellRunCommandScript(tokens);
    expect(script).toContain('[Console]::Out.Write(');
    expect(script).toContain('Invoke-Expression $__bestide_run_command');
    expect(script).toContain('$LASTEXITCODE');
    expect(script).toContain(tokens.endTokenPrefix.replace(/'/g, "''"));
  });

  it('dispatches by shell kind', () => {
    expect(buildRunCommandScript('posix', tokens)).toContain('eval ');
    expect(buildRunCommandScript('powershell', tokens)).toContain('Invoke-Expression');
  });

  it('resolves posix and windows launches', () => {
    const posix = resolveRunCommandShellLaunch('darwin', { SHELL: '/bin/zsh' });
    expect(posix).toEqual({ command: '/bin/zsh', args: ['-s'], kind: 'posix' });

    const win = resolveRunCommandShellLaunch('win32', {});
    expect(win?.kind).toBe('powershell');
    expect(win?.command).toBe('powershell.exe');
    expect(win?.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']);

    const pwsh = resolveRunCommandShellLaunch('win32', { BESTIDE_PWSH: 'pwsh' });
    expect(pwsh?.command).toBe('pwsh');
  });
});
