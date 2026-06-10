export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Editor-agnostic workspace operations. The VS Code extension implements this
 * with `vscode.workspace.fs` etc.; tests implement it with in-memory mocks.
 * All paths are workspace-relative.
 */
export interface WorkspaceHost {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  grep(pattern: string, include?: string): Promise<string>;
  semanticSearch?(query: string, include?: string, limit?: number): Promise<string>;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  runCommand?(command: string, timeoutMs?: number): Promise<ExecResult>;
  getDiagnostics?(path?: string): Promise<string>;
  getSymbols?(query?: string, path?: string): Promise<string>;
  listMcpTools?(server?: string): Promise<string>;
  callMcpTool?(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
}
