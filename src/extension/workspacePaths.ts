import * as path from 'node:path';

export interface WorkspaceRoot {
  name: string;
  fsPath: string;
}

export interface ResolvedWorkspacePath {
  root: WorkspaceRoot;
  relativePath: string;
  absolutePath: string;
  displayPath: string;
}

function normalizeInputPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '') {
    return '.';
  }
  return trimmed.replaceAll('\\', '/');
}

function isWithinRoot(absolutePath: string, rootPath: string): boolean {
  return absolutePath === rootPath || absolutePath.startsWith(rootPath + path.sep);
}

function primaryRoot(
  roots: readonly WorkspaceRoot[],
  primaryRootName?: string
): WorkspaceRoot {
  if (roots.length === 0) {
    throw new Error('workspace has no root folders');
  }
  if (!primaryRootName) {
    return roots[0]!;
  }
  return roots.find((root) => root.name === primaryRootName) ?? roots[0]!;
}

function parseRootPrefix(
  inputPath: string,
  roots: readonly WorkspaceRoot[],
  fallbackRoot: WorkspaceRoot
): { root: WorkspaceRoot; relativePath: string } {
  const slash = inputPath.indexOf('/');
  const firstSegment = slash === -1 ? inputPath : inputPath.slice(0, slash);
  const prefixedRoot = roots.find((root) => root.name === firstSegment);
  if (!prefixedRoot) {
    return { root: fallbackRoot, relativePath: inputPath };
  }
  const remainder = slash === -1 ? '.' : inputPath.slice(slash + 1);
  return { root: prefixedRoot, relativePath: remainder === '' ? '.' : remainder };
}

function relativeDisplayPath(root: WorkspaceRoot, absolutePath: string): string {
  const relative = path.relative(root.fsPath, absolutePath);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

export function resolveWorkspacePath(
  inputPath: string,
  roots: readonly WorkspaceRoot[],
  primaryRootName?: string
): ResolvedWorkspacePath {
  const normalized = normalizeInputPath(inputPath);
  if (path.isAbsolute(normalized)) {
    throw new Error(`path "${inputPath}" must be workspace-relative`);
  }

  const primary = primaryRoot(roots, primaryRootName);
  const { root, relativePath } =
    roots.length > 1 ? parseRootPrefix(normalized, roots, primary) : { root: primary, relativePath: normalized };
  const absolutePath = path.resolve(root.fsPath, relativePath);

  if (!isWithinRoot(absolutePath, root.fsPath)) {
    throw new Error(`path "${inputPath}" is outside the workspace`);
  }

  const relative = relativeDisplayPath(root, absolutePath);
  const displayPath = roots.length > 1 ? (relative === '.' ? root.name : `${root.name}/${relative}`) : relative;

  return {
    root,
    relativePath: relative,
    absolutePath,
    displayPath,
  };
}

export function displayWorkspacePath(
  absolutePath: string,
  roots: readonly WorkspaceRoot[],
  primaryRootName?: string
): string | undefined {
  if (roots.length === 0) {
    return undefined;
  }

  const sortedRoots = [...roots].sort((a, b) => b.fsPath.length - a.fsPath.length);
  const matchingRoot = sortedRoots.find((root) => isWithinRoot(absolutePath, root.fsPath));
  if (!matchingRoot) {
    return undefined;
  }

  const relative = relativeDisplayPath(matchingRoot, absolutePath);
  if (roots.length === 1) {
    return relative;
  }

  const primary = primaryRoot(roots, primaryRootName);
  if (matchingRoot.name === primary.name) {
    return `${matchingRoot.name}/${relative === '.' ? '' : relative}`.replace(/\/$/, '');
  }
  return `${matchingRoot.name}/${relative === '.' ? '' : relative}`.replace(/\/$/, '');
}
