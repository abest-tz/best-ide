import { describe, expect, it } from 'vitest';
import { displayWorkspacePath, resolveWorkspacePath, type WorkspaceRoot } from '../src/extension/workspacePaths';

describe('resolveWorkspacePath', () => {
  it('resolves single-root paths without a prefix', () => {
    const roots: WorkspaceRoot[] = [{ name: 'app', fsPath: '/repo/app' }];
    const resolved = resolveWorkspacePath('src/main.ts', roots, 'app');

    expect(resolved.absolutePath).toBe('/repo/app/src/main.ts');
    expect(resolved.displayPath).toBe('src/main.ts');
  });

  it('supports prefixed paths in multi-root workspaces', () => {
    const roots: WorkspaceRoot[] = [
      { name: 'app', fsPath: '/repo/app' },
      { name: 'lib', fsPath: '/repo/lib' },
    ];
    const resolved = resolveWorkspacePath('lib/src/util.ts', roots, 'app');

    expect(resolved.absolutePath).toBe('/repo/lib/src/util.ts');
    expect(resolved.displayPath).toBe('lib/src/util.ts');
  });

  it('defaults unprefixed paths to the primary workspace root', () => {
    const roots: WorkspaceRoot[] = [
      { name: 'app', fsPath: '/repo/app' },
      { name: 'lib', fsPath: '/repo/lib' },
    ];
    const resolved = resolveWorkspacePath('src/main.ts', roots, 'app');

    expect(resolved.absolutePath).toBe('/repo/app/src/main.ts');
    expect(resolved.displayPath).toBe('app/src/main.ts');
  });

  it('rejects paths that escape the workspace root', () => {
    const roots: WorkspaceRoot[] = [{ name: 'app', fsPath: '/repo/app' }];
    expect(() => resolveWorkspacePath('../secrets.txt', roots, 'app')).toThrow(/outside the workspace/i);
  });
});

describe('displayWorkspacePath', () => {
  it('returns prefixed display paths for multi-root files', () => {
    const roots: WorkspaceRoot[] = [
      { name: 'app', fsPath: '/repo/app' },
      { name: 'lib', fsPath: '/repo/lib' },
    ];
    expect(displayWorkspacePath('/repo/lib/src/util.ts', roots, 'app')).toBe('lib/src/util.ts');
  });

  it('returns undefined when path is outside the workspace', () => {
    const roots: WorkspaceRoot[] = [{ name: 'app', fsPath: '/repo/app' }];
    expect(displayWorkspacePath('/tmp/outside.ts', roots, 'app')).toBeUndefined();
  });
});
