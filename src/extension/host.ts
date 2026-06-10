import { exec } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DirEntry, ExecResult, WorkspaceHost } from '../core/host';

const GREP_MAX_FILES = 2000;
const GREP_MAX_RESULTS = 200;
const GREP_EXCLUDE = '{**/node_modules/**,**/dist/**,**/.git/**,**/coverage/**}';
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

export class VsCodeWorkspaceHost implements WorkspaceHost {
  private readonly root: vscode.Uri;

  constructor(root: vscode.Uri) {
    this.root = root;
  }

  /** Resolves a workspace-relative path, refusing escapes outside the root. */
  private resolve(relativePath: string): vscode.Uri {
    const rootPath = this.root.fsPath;
    const absolute = path.resolve(rootPath, relativePath);
    if (absolute !== rootPath && !absolute.startsWith(rootPath + path.sep)) {
      throw new Error(`path "${relativePath}" is outside the workspace`);
    }
    return vscode.Uri.file(absolute);
  }

  async readFile(relativePath: string): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(this.resolve(relativePath));
    return new TextDecoder().decode(bytes);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(this.resolve(relativePath), new TextEncoder().encode(content));
  }

  async listDir(relativePath: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.resolve(relativePath));
    return entries
      .map(([name, fileType]): DirEntry => ({
        name,
        type: fileType === vscode.FileType.Directory ? 'dir' : 'file',
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  async grep(pattern: string, include?: string): Promise<string> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error(`invalid regular expression: ${pattern}`);
    }

    const files = await vscode.workspace.findFiles(
      include ? `**/${include}` : '**/*',
      GREP_EXCLUDE,
      GREP_MAX_FILES
    );

    const results: string[] = [];
    for (const file of files) {
      if (results.length >= GREP_MAX_RESULTS) {
        break;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          await vscode.workspace.fs.readFile(file)
        );
      } catch {
        continue; // skip binary/unreadable files
      }
      const relative = path.relative(this.root.fsPath, file.fsPath);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < GREP_MAX_RESULTS; i++) {
        if (regex.test(lines[i]!)) {
          results.push(`${relative}:${i + 1}:${lines[i]!.trim().slice(0, 300)}`);
        }
      }
    }
    return results.join('\n');
  }

  exec(command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: this.root.fsPath, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          });
        }
      );
    });
  }
}
