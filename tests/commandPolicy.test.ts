import { describe, expect, it } from 'vitest';
import { evaluateCommandPolicy, extractCommandExecutables, tokenizeCommand } from '../src/extension/commandPolicy';

describe('command policy parsing', () => {
  it('tokenizes shell operators without surrounding whitespace', () => {
    expect(tokenizeCommand('npm test&&echo done|sed -n "1,3p";git status')).toEqual([
      'npm',
      'test',
      '&&',
      'echo',
      'done',
      '|',
      'sed',
      '-n',
      '1,3p',
      ';',
      'git',
      'status',
    ]);
  });

  it('extracts executable names from chained commands', () => {
    expect(extractCommandExecutables('FOO=1 npm test && git status | sed -n "1,10p"')).toEqual([
      'npm',
      'git',
      'sed',
    ]);
  });

  it('resolves wrapped env commands to their executable', () => {
    expect(extractCommandExecutables('env FOO=bar /usr/bin/git status')).toEqual(['/usr/bin/git']);
  });
});

describe('command policy enforcement', () => {
  it('rejects empty command lines', () => {
    const result = evaluateCommandPolicy('   ', { allowlist: [], denylist: [] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it('blocks denylisted commands', () => {
    const result = evaluateCommandPolicy('npm test && rm -rf dist', {
      allowlist: [],
      denylist: ['rm'],
    });
    expect(result).toMatchObject({
      allowed: false,
      executable: 'rm',
    });
    expect(result.reason).toMatch(/denylist/i);
  });

  it('requires all command segments to be allowlisted', () => {
    const result = evaluateCommandPolicy('npm test && git status', {
      allowlist: ['npm'],
      denylist: [],
    });
    expect(result).toMatchObject({
      allowed: false,
      executable: 'git',
    });
    expect(result.reason).toMatch(/allowlist/i);
  });

  it('matches allowlist entries by executable basename', () => {
    const result = evaluateCommandPolicy('/usr/bin/git status', {
      allowlist: ['git'],
      denylist: [],
    });
    expect(result.allowed).toBe(true);
  });
});
