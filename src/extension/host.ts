import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DirEntry, ExecResult, WorkspaceHost } from '../core/host';
import { evaluateCommandPolicy, type CommandPolicy } from './commandPolicy';
import {
  RUN_COMMAND_TIMEOUT_DEFAULT_MS,
  RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS,
  resolveCommandTimeoutMs,
  resolveSandboxCwd,
  type RunCommandTimeoutPolicy,
} from './runCommandSandbox';
import {
  OpenAIEmbeddingClient,
  buildSemanticIndex,
  formatSemanticResults,
  rankSemanticChunks,
  type SemanticChunk,
  type SemanticDocument,
} from './semanticIndex';
import {
  AGENT_SHELL_END_PREFIX,
  AGENT_SHELL_SENTINEL,
  AGENT_SHELL_START_PREFIX,
  buildRunCommandScript,
  resolveRunCommandShellCandidates,
  type RunCommandShellLaunch,
} from './runCommandShell';
import {
  displayWorkspacePath,
  resolveWorkspacePath,
  type WorkspaceRoot,
} from './workspacePaths';
import {
  formatMcpToolList,
  McpClientManager,
  type McpServerConfig,
} from './mcpClient';

const GREP_MAX_FILES = 2000;
const GREP_MAX_RESULTS = 200;
const GREP_EXCLUDE = '{**/node_modules/**,**/dist/**,**/.git/**,**/coverage/**}';
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const DIAGNOSTICS_MAX_RESULTS = 500;
const SYMBOLS_MAX_RESULTS = 300;
const SEMANTIC_MAX_FILES = 400;
const SEMANTIC_MAX_FILE_CHARS = 250_000;
const SEMANTIC_CACHE_TTL_MS = 5 * 60_000;
const AGENT_SHELL_EXIT_CODE_TAIL_GUARD = 32;
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const OSC_ESCAPE_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

export interface StagedWrite {
  targetUri: vscode.Uri;
  path: string;
  previousContent: string | undefined;
  content: string;
}

interface SemanticSearchOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface McpOptions {
  servers: Record<string, McpServerConfig>;
  requestTimeoutMs: number;
}

interface RunCommandOptions {
  allowlist?: readonly string[];
  denylist?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxTimeoutMs?: number;
}

interface VsCodeWorkspaceHostOptions {
  onWriteFile?: (change: StagedWrite) => Promise<void> | void;
  /** When set, `readFile` returns staged content instead of disk for that path. */
  getPendingContent?: (path: string) => string | undefined;
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  semanticSearch?: SemanticSearchOptions;
  mcp?: McpOptions;
  runCommand?: RunCommandOptions;
}

interface CachedSemanticIndex {
  fingerprint: string;
  include: string | undefined;
  model: string;
  builtAtMs: number;
  chunks: SemanticChunk[];
}

interface AgentShellRequest {
  id: string;
  command: string;
  timeoutMs: number;
  startToken: string;
  endTokenPrefix: string;
  started: boolean;
  stdout: string;
  stderr: string;
  timeoutHandle: NodeJS.Timeout | undefined;
  resolve(result: ExecResult): void;
  reject(error: Error): void;
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
  }
  return 'unknown';
}

interface FlattenedSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  container?: string;
}

function uniqueRootName(baseName: string, used: Set<string>): string {
  let candidate = baseName || 'workspace';
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseName || 'workspace'}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildWorkspaceRoots(
  primaryRoot: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[]
): WorkspaceRoot[] {
  const ordered: Array<{ name: string; fsPath: string }> = [];
  const seenPaths = new Set<string>();
  const pushRoot = (name: string, fsPath: string): void => {
    if (seenPaths.has(fsPath)) {
      return;
    }
    seenPaths.add(fsPath);
    ordered.push({ name, fsPath });
  };

  for (const folder of folders) {
    pushRoot(folder.name, folder.uri.fsPath);
  }
  pushRoot(path.basename(primaryRoot.fsPath), primaryRoot.fsPath);

  const usedNames = new Set<string>();
  return ordered.map((entry) => ({
    name: uniqueRootName(entry.name, usedNames),
    fsPath: entry.fsPath,
  }));
}

function resolveMcpServerConfigs(
  workspaceRootPath: string,
  servers: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => {
      if (!config.cwd) {
        return [name, config];
      }
      return [
        name,
        {
          ...config,
          cwd: path.isAbsolute(config.cwd) ? config.cwd : path.resolve(workspaceRootPath, config.cwd),
        },
      ];
    })
  );
}

function normalizeCommandEntries(entries: readonly string[] | undefined): string[] {
  return (entries ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function sanitizeTerminalOutput(output: string): string {
  return output
    .replace(OSC_ESCAPE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r/g, '');
}

export class VsCodeWorkspaceHost implements WorkspaceHost {
  private readonly root: vscode.Uri;
  private readonly options: VsCodeWorkspaceHostOptions;
  private readonly roots: WorkspaceRoot[];
  private readonly primaryRootName: string;
  private readonly mcpClient: McpClientManager | undefined;
  private readonly commandPolicy: CommandPolicy;
  private readonly runCommandCwd: string;
  private readonly runCommandEnv: Record<string, string>;
  private readonly runCommandStrictEnv: boolean;
  private readonly runCommandTimeoutPolicy: RunCommandTimeoutPolicy;
  private readonly runCommandSandboxConfigurationError: string | undefined;
  private readonly runCommandQueue: AgentShellRequest[] = [];
  private runCommandShell: ChildProcessWithoutNullStreams | undefined;
  private runCommandShellKind: RunCommandShellLaunch['kind'] = 'posix';
  private runCommandShellStdoutBuffer = '';
  private runCommandShellActiveRequest: AgentShellRequest | undefined;
  private runCommandShellRequestCounter = 0;
  private semanticIndexCache: CachedSemanticIndex | undefined;

  constructor(root: vscode.Uri, options: VsCodeWorkspaceHostOptions = {}) {
    this.root = root;
    this.options = options;
    this.roots = buildWorkspaceRoots(root, options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? []);
    this.primaryRootName =
      this.roots.find((workspaceRoot) => workspaceRoot.fsPath === root.fsPath)?.name ??
      this.roots[0]?.name ??
      '';
    this.mcpClient =
      options.mcp && Object.keys(options.mcp.servers).length > 0
        ? new McpClientManager(resolveMcpServerConfigs(root.fsPath, options.mcp.servers))
        : undefined;
    this.commandPolicy = {
      allowlist: normalizeCommandEntries(options.runCommand?.allowlist),
      denylist: normalizeCommandEntries(options.runCommand?.denylist),
    };

    let resolvedRunCommandCwd = root.fsPath;
    let runCommandSandboxConfigurationError: string | undefined;
    try {
      resolvedRunCommandCwd = resolveSandboxCwd(root.fsPath, options.runCommand?.cwd);
    } catch (error) {
      runCommandSandboxConfigurationError = error instanceof Error ? error.message : String(error);
    }
    const configuredRunCommandTimeoutMs = options.runCommand?.timeoutMs;
    const configuredRunCommandMaxTimeoutMs = options.runCommand?.maxTimeoutMs;
    const normalizedRunCommandTimeoutMs =
      typeof configuredRunCommandTimeoutMs === 'number' && Number.isFinite(configuredRunCommandTimeoutMs)
        ? Math.max(100, Math.floor(configuredRunCommandTimeoutMs))
        : RUN_COMMAND_TIMEOUT_DEFAULT_MS;
    const normalizedRunCommandMaxTimeoutMs =
      typeof configuredRunCommandMaxTimeoutMs === 'number' && Number.isFinite(configuredRunCommandMaxTimeoutMs)
        ? Math.max(100, Math.floor(configuredRunCommandMaxTimeoutMs))
        : Math.max(normalizedRunCommandTimeoutMs, RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS);
    this.runCommandCwd = resolvedRunCommandCwd;
    this.runCommandEnv = { ...(options.runCommand?.env ?? {}) };
    this.runCommandStrictEnv = options.runCommand?.inheritEnv === false;
    this.runCommandTimeoutPolicy = {
      timeoutMs: normalizedRunCommandTimeoutMs,
      maxTimeoutMs: Math.max(normalizedRunCommandTimeoutMs, normalizedRunCommandMaxTimeoutMs),
    };
    this.runCommandSandboxConfigurationError = runCommandSandboxConfigurationError;
  }

  /** Resolves a workspace-relative path, refusing escapes outside the root. */
  private resolve(relativePath: string): vscode.Uri {
    const resolved = resolveWorkspacePath(relativePath, this.roots, this.primaryRootName);
    return vscode.Uri.file(resolved.absolutePath);
  }

  private displayPath(uri: vscode.Uri): string | undefined {
    return displayWorkspacePath(uri.fsPath, this.roots, this.primaryRootName);
  }

  async readFile(relativePath: string): Promise<string> {
    const resolved = resolveWorkspacePath(relativePath, this.roots, this.primaryRootName);
    const pending = this.options.getPendingContent?.(resolved.displayPath);
    if (pending !== undefined) {
      return pending;
    }
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved.absolutePath));
    return new TextDecoder().decode(bytes);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const resolved = resolveWorkspacePath(relativePath, this.roots, this.primaryRootName);
    const uri = vscode.Uri.file(resolved.absolutePath);
    const pending = this.options.getPendingContent?.(resolved.displayPath);
    let previousContent: string | undefined;
    if (pending !== undefined) {
      previousContent = pending;
    } else {
      try {
        previousContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        previousContent = undefined;
      }
    }

    if (this.options.onWriteFile) {
      await this.options.onWriteFile({
        targetUri: uri,
        path: resolved.displayPath,
        previousContent,
        content,
      });
      return;
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async listDir(relativePath: string): Promise<DirEntry[]> {
    if (this.roots.length > 1) {
      const normalized = relativePath.trim();
      if (normalized === '' || normalized === '.' || normalized === './') {
        return this.roots
          .map((root): DirEntry => ({ name: root.name, type: 'dir' }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    }
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
      const relative = this.displayPath(file);
      if (!relative) {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < GREP_MAX_RESULTS; i++) {
        if (regex.test(lines[i]!)) {
          results.push(`${relative}:${i + 1}:${lines[i]!.trim().slice(0, 300)}`);
        }
      }
    }
    return results.join('\n');
  }

  async semanticSearch(query: string, include?: string, limit = 5): Promise<string> {
    const trimmedQuery = query.trim();
    if (trimmedQuery === '') {
      throw new Error('query cannot be empty');
    }

    const config = this.options.semanticSearch;
    const model = config?.model.trim() ?? '';
    if (!config || model === '') {
      throw new Error(
        'semantic search is not configured; set bestIde.embeddingModel to an embeddings-capable model id'
      );
    }

    const includeGlob = include && include.trim() !== '' ? include.trim() : undefined;
    const { documents, fingerprint } = await this.loadSemanticDocuments(includeGlob);
    if (documents.length === 0) {
      return '(no indexable files)';
    }

    const embeddingClient = new OpenAIEmbeddingClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model,
    });
    const now = Date.now();
    let chunks: SemanticChunk[];
    const cached = this.semanticIndexCache;
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      cached.include === includeGlob &&
      cached.model === model &&
      now - cached.builtAtMs <= SEMANTIC_CACHE_TTL_MS
    ) {
      chunks = cached.chunks;
    } else {
      chunks = await buildSemanticIndex(documents, embeddingClient);
      this.semanticIndexCache = {
        fingerprint,
        include: includeGlob,
        model,
        builtAtMs: now,
        chunks,
      };
    }

    if (chunks.length === 0) {
      return '(no semantic matches)';
    }

    const [queryEmbedding] = await embeddingClient.embed([trimmedQuery]);
    if (!queryEmbedding) {
      return '(no semantic matches)';
    }
    const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
    return formatSemanticResults(rankSemanticChunks(chunks, queryEmbedding, safeLimit));
  }

  private async loadSemanticDocuments(
    includeGlob?: string
  ): Promise<{ documents: SemanticDocument[]; fingerprint: string }> {
    const files = await vscode.workspace.findFiles(
      includeGlob ? `**/${includeGlob}` : '**/*',
      GREP_EXCLUDE,
      SEMANTIC_MAX_FILES
    );
    const indexed: Array<{ document: SemanticDocument; fingerprint: string }> = [];

    for (const file of files) {
      const relative = this.displayPath(file);
      if (!relative) {
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(file));
      } catch {
        continue;
      }
      if (text.trim() === '' || text.length > SEMANTIC_MAX_FILE_CHARS) {
        continue;
      }

      let fileFingerprint = `${relative}:0:${text.length}`;
      try {
        const stat = await vscode.workspace.fs.stat(file);
        fileFingerprint = `${relative}:${stat.mtime}:${stat.size}`;
      } catch {
        // Fall back to text length fingerprint when stat lookup fails.
      }

      indexed.push({
        document: { path: relative, content: text },
        fingerprint: fileFingerprint,
      });
    }

    indexed.sort((a, b) => a.document.path.localeCompare(b.document.path));
    return {
      documents: indexed.map((entry) => entry.document),
      fingerprint: indexed.map((entry) => entry.fingerprint).join('\n'),
    };
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

  async runCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
    const policyDecision = evaluateCommandPolicy(command, this.commandPolicy);
    if (!policyDecision.allowed) {
      throw new Error(policyDecision.reason ?? 'run_command is blocked by policy');
    }
    if (command.includes('\n') || command.includes('\r')) {
      throw new Error('run_command supports single-line commands only');
    }
    if (this.runCommandSandboxConfigurationError) {
      throw new Error(this.runCommandSandboxConfigurationError);
    }
    const effectiveTimeoutMs = resolveCommandTimeoutMs(timeoutMs, this.runCommandTimeoutPolicy);
    try {
      return await this.enqueueRunCommand(command, effectiveTimeoutMs);
    } catch (error) {
      if (process.platform === 'win32' && this.isShellUnavailableError(error)) {
        return this.execRunCommandFallback(command, effectiveTimeoutMs);
      }
      throw error;
    }
  }

  private isShellUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOENT|not found|failed to spawn|agent command shell/i.test(message);
  }

  private execRunCommandFallback(command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          cwd: this.runCommandCwd,
          env: this.resolveRunCommandEnv(),
          timeout: timeoutMs,
          maxBuffer: EXEC_MAX_BUFFER,
        },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            reject(new Error(`command timed out after ${timeoutMs}ms`));
            return;
          }
          resolve({
            stdout: sanitizeTerminalOutput(stdout).trim(),
            stderr: sanitizeTerminalOutput(stderr).trim(),
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          });
        }
      );
    });
  }

  private enqueueRunCommand(command: string, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${++this.runCommandShellRequestCounter}`;
      this.runCommandQueue.push({
        id: requestId,
        command,
        timeoutMs,
        startToken: `${AGENT_SHELL_SENTINEL}${AGENT_SHELL_START_PREFIX}${requestId}${AGENT_SHELL_SENTINEL}`,
        endTokenPrefix: `${AGENT_SHELL_SENTINEL}${AGENT_SHELL_END_PREFIX}${requestId}:`,
        started: false,
        stdout: '',
        stderr: '',
        timeoutHandle: undefined,
        resolve,
        reject,
      });
      this.processRunCommandQueue();
    });
  }

  private processRunCommandQueue(): void {
    if (this.runCommandShellActiveRequest) {
      return;
    }
    const request = this.runCommandQueue.shift();
    if (!request) {
      return;
    }

    let shell: ChildProcessWithoutNullStreams;
    try {
      shell = this.ensureRunCommandShell();
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
      this.processRunCommandQueue();
      return;
    }

    this.runCommandShellActiveRequest = request;
    request.timeoutHandle = setTimeout(() => {
      this.onRunCommandTimeout(request);
    }, request.timeoutMs);

    try {
      shell.stdin.write(this.buildRunCommandScript(request));
    } catch (error) {
      this.failRunCommandRequest(
        request,
        error instanceof Error ? error : new Error('failed to write command to agent shell')
      );
    }
  }

  private ensureRunCommandShell(): ChildProcessWithoutNullStreams {
    if (this.runCommandShell && !this.runCommandShell.killed) {
      return this.runCommandShell;
    }
    const launch = resolveRunCommandShellCandidates(process.platform)[0];
    if (!launch) {
      throw new Error('no agent command shell available');
    }
    const shell = spawn(launch.command, launch.args, {
      cwd: this.runCommandCwd,
      env: this.resolveRunCommandEnv(),
      stdio: 'pipe',
    });
    this.runCommandShellKind = launch.kind;
    shell.stdout.setEncoding('utf8');
    shell.stderr.setEncoding('utf8');
    shell.stdout.on('data', (chunk: string | Buffer) => {
      this.handleRunCommandStdoutChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    shell.stderr.on('data', (chunk: string | Buffer) => {
      this.handleRunCommandStderrChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    shell.on('error', (error) => {
      if (this.runCommandShell !== shell) {
        return;
      }
      this.runCommandShell = undefined;
      this.runCommandShellStdoutBuffer = '';
      this.failActiveRunCommandRequest(error instanceof Error ? error : new Error(String(error)));
    });
    shell.on('exit', (code, signal) => {
      if (this.runCommandShell !== shell) {
        return;
      }
      this.runCommandShell = undefined;
      this.runCommandShellStdoutBuffer = '';
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this.failActiveRunCommandRequest(new Error(`agent command shell exited unexpectedly (${reason})`));
    });
    this.runCommandShell = shell;
    return shell;
  }

  private resolveRunCommandEnv(): NodeJS.ProcessEnv {
    if (this.runCommandStrictEnv) {
      return { ...this.runCommandEnv };
    }
    return { ...process.env, ...this.runCommandEnv };
  }

  private buildRunCommandScript(request: AgentShellRequest): string {
    return buildRunCommandScript(this.runCommandShellKind, {
      command: request.command,
      startToken: request.startToken,
      endTokenPrefix: request.endTokenPrefix,
    });
  }

  private handleRunCommandStdoutChunk(chunk: string): void {
    if (chunk === '') {
      return;
    }
    this.runCommandShellStdoutBuffer += chunk;
    this.consumeRunCommandStdoutBuffer();
  }

  private consumeRunCommandStdoutBuffer(): void {
    const request = this.runCommandShellActiveRequest;
    if (!request) {
      this.runCommandShellStdoutBuffer = '';
      return;
    }

    let buffer = this.runCommandShellStdoutBuffer;
    if (!request.started) {
      const startIndex = buffer.indexOf(request.startToken);
      if (startIndex === -1) {
        const keepChars = Math.max(0, request.startToken.length - 1);
        this.runCommandShellStdoutBuffer = keepChars === 0 ? '' : buffer.slice(-keepChars);
        return;
      }
      request.started = true;
      buffer = buffer.slice(startIndex + request.startToken.length);
    }

    const endIndex = buffer.indexOf(request.endTokenPrefix);
    if (endIndex === -1) {
      const keepChars = request.endTokenPrefix.length + AGENT_SHELL_EXIT_CODE_TAIL_GUARD;
      if (buffer.length > keepChars) {
        request.stdout = this.appendCapturedOutput(request.stdout, buffer.slice(0, buffer.length - keepChars));
        buffer = buffer.slice(-keepChars);
      }
      this.runCommandShellStdoutBuffer = buffer;
      return;
    }

    request.stdout = this.appendCapturedOutput(request.stdout, buffer.slice(0, endIndex));
    const exitCodeStart = endIndex + request.endTokenPrefix.length;
    const exitCodeEnd = buffer.indexOf(AGENT_SHELL_SENTINEL, exitCodeStart);
    if (exitCodeEnd === -1) {
      this.runCommandShellStdoutBuffer = buffer.slice(endIndex);
      return;
    }

    const parsedExitCode = Number.parseInt(buffer.slice(exitCodeStart, exitCodeEnd).trim(), 10);
    const exitCode = Number.isFinite(parsedExitCode) ? parsedExitCode : 1;
    this.runCommandShellStdoutBuffer = buffer.slice(exitCodeEnd + AGENT_SHELL_SENTINEL.length);
    this.completeRunCommandRequest(request, exitCode);
  }

  private handleRunCommandStderrChunk(chunk: string): void {
    if (chunk === '') {
      return;
    }
    const request = this.runCommandShellActiveRequest;
    if (!request) {
      return;
    }
    request.stderr = this.appendCapturedOutput(request.stderr, chunk);
  }

  private appendCapturedOutput(current: string, nextChunk: string): string {
    if (nextChunk === '' || current.length >= EXEC_MAX_BUFFER) {
      return current;
    }
    const remaining = EXEC_MAX_BUFFER - current.length;
    return current + nextChunk.slice(0, remaining);
  }

  private completeRunCommandRequest(request: AgentShellRequest, exitCode: number): void {
    if (this.runCommandShellActiveRequest !== request) {
      return;
    }
    this.clearRunCommandTimeout(request);
    this.runCommandShellActiveRequest = undefined;
    request.resolve({
      stdout: sanitizeTerminalOutput(request.stdout).trim(),
      stderr: sanitizeTerminalOutput(request.stderr).trim(),
      exitCode,
    });
    this.processRunCommandQueue();
    this.consumeRunCommandStdoutBuffer();
  }

  private failActiveRunCommandRequest(error: Error): void {
    const request = this.runCommandShellActiveRequest;
    if (!request) {
      return;
    }
    this.failRunCommandRequest(request, error);
  }

  private failRunCommandRequest(request: AgentShellRequest, error: Error): void {
    if (this.runCommandShellActiveRequest === request) {
      this.runCommandShellActiveRequest = undefined;
    }
    this.clearRunCommandTimeout(request);
    request.reject(error);
    this.processRunCommandQueue();
  }

  private onRunCommandTimeout(request: AgentShellRequest): void {
    if (this.runCommandShellActiveRequest !== request) {
      return;
    }
    this.terminateRunCommandShell();
    this.failRunCommandRequest(request, new Error(`command timed out after ${request.timeoutMs}ms`));
  }

  private clearRunCommandTimeout(request: AgentShellRequest): void {
    if (request.timeoutHandle) {
      clearTimeout(request.timeoutHandle);
      request.timeoutHandle = undefined;
    }
  }

  private terminateRunCommandShell(): void {
    const shell = this.runCommandShell;
    if (!shell) {
      return;
    }
    this.runCommandShell = undefined;
    this.runCommandShellStdoutBuffer = '';
    if (!shell.killed) {
      shell.kill();
    }
  }

  async getDiagnostics(relativePath?: string): Promise<string> {
    const diagnosticsByFile: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = [];
    if (relativePath) {
      const uri = this.resolve(relativePath);
      diagnosticsByFile.push([uri, vscode.languages.getDiagnostics(uri)]);
    } else {
      diagnosticsByFile.push(...vscode.languages.getDiagnostics());
    }

    const lines: string[] = [];
    for (const [uri, diagnostics] of diagnosticsByFile) {
      const relative = this.displayPath(uri);
      if (!relative) {
        continue;
      }
      for (const diagnostic of diagnostics) {
        if (lines.length >= DIAGNOSTICS_MAX_RESULTS) {
          return `${lines.join('\n')}\n... [truncated]`;
        }
        lines.push(
          `${relative}:${diagnostic.range.start.line + 1}:${severityLabel(diagnostic.severity)}:${diagnostic.message}`
        );
      }
    }

    return lines.length > 0 ? lines.join('\n') : '(no diagnostics)';
  }

  async getSymbols(query?: string, relativePath?: string): Promise<string> {
    const out: FlattenedSymbol[] = [];

    if (relativePath) {
      const uri = this.resolve(relativePath);
      const resolvedPath = this.displayPath(uri) ?? relativePath;
      const symbols =
        (await vscode.commands.executeCommand<
          readonly vscode.DocumentSymbol[] | readonly vscode.SymbolInformation[] | undefined
        >('vscode.executeDocumentSymbolProvider', uri)) ?? [];
      for (const symbol of symbols) {
        if (out.length >= SYMBOLS_MAX_RESULTS) {
          break;
        }
        if ('children' in symbol && 'selectionRange' in symbol) {
          this.collectDocumentSymbols(symbol, resolvedPath, out, undefined);
        } else {
          out.push({
            name: symbol.name,
            kind: vscode.SymbolKind[symbol.kind] ?? 'Unknown',
            path: resolvedPath,
            line: symbol.location.range.start.line + 1,
            container: symbol.containerName || undefined,
          });
        }
      }
    } else {
      const symbols =
        (await vscode.commands.executeCommand<readonly vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          query ?? ''
        )) ?? [];
      for (const symbol of symbols.slice(0, SYMBOLS_MAX_RESULTS)) {
        const relative = this.displayPath(symbol.location.uri);
        if (!relative) {
          continue;
        }
        out.push({
          name: symbol.name,
          kind: vscode.SymbolKind[symbol.kind] ?? 'Unknown',
          path: relative,
          line: symbol.location.range.start.line + 1,
          container: symbol.containerName || undefined,
        });
      }
    }

    const filtered =
      query && query.trim() !== ''
        ? out.filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase()))
        : out;
    if (filtered.length === 0) {
      return '(no symbols)';
    }
    return filtered
      .slice(0, SYMBOLS_MAX_RESULTS)
      .map((symbol) =>
        `${symbol.path}:${symbol.line}:${symbol.kind}:${symbol.container ? `${symbol.container}.` : ''}${symbol.name}`
      )
      .join('\n');
  }

  async listMcpTools(serverName?: string): Promise<string> {
    if (!this.mcpClient) {
      throw new Error('MCP is not configured; set bestIde.mcp.servers to enable MCP tools');
    }
    const tools = await this.mcpClient.listTools(serverName, this.options.mcp?.requestTimeoutMs);
    return formatMcpToolList(tools);
  }

  async callMcpTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (!this.mcpClient) {
      throw new Error('MCP is not configured; set bestIde.mcp.servers to enable MCP tools');
    }
    return this.mcpClient.callTool(serverName, toolName, args, this.options.mcp?.requestTimeoutMs);
  }

  private collectDocumentSymbols(
    symbol: vscode.DocumentSymbol,
    relativePath: string,
    out: FlattenedSymbol[],
    container: string | undefined
  ): void {
    if (out.length >= SYMBOLS_MAX_RESULTS) {
      return;
    }
    const nextContainer = container ? `${container}.${symbol.name}` : symbol.name;
    out.push({
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind] ?? 'Unknown',
      path: relativePath,
      line: symbol.selectionRange.start.line + 1,
      container,
    });
    for (const child of symbol.children) {
      this.collectDocumentSymbols(child, relativePath, out, nextContainer);
      if (out.length >= SYMBOLS_MAX_RESULTS) {
        return;
      }
    }
  }
}
