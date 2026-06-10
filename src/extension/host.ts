import { exec } from 'node:child_process';
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
const RUN_COMMAND_TERMINAL_NAME = 'Best IDE Agent';
const SHELL_INTEGRATION_TIMEOUT_MS = 3_000;
const OUTPUT_FLUSH_GRACE_MS = 120;
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
  shellIntegrationTimeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxTimeoutMs?: number;
}

interface VsCodeWorkspaceHostOptions {
  onWriteFile?: (change: StagedWrite) => Promise<void> | void;
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
  private readonly shellIntegrationTimeoutMs: number;
  private readonly runCommandCwd: string;
  private readonly runCommandEnv: Record<string, string>;
  private readonly runCommandStrictEnv: boolean;
  private readonly runCommandTimeoutPolicy: RunCommandTimeoutPolicy;
  private readonly runCommandSandboxConfigurationError: string | undefined;
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
    const configuredShellIntegrationTimeoutMs = options.runCommand?.shellIntegrationTimeoutMs;
    this.shellIntegrationTimeoutMs =
      typeof configuredShellIntegrationTimeoutMs === 'number' &&
      Number.isFinite(configuredShellIntegrationTimeoutMs)
        ? Math.max(500, Math.floor(configuredShellIntegrationTimeoutMs))
        : SHELL_INTEGRATION_TIMEOUT_MS;

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
    const bytes = await vscode.workspace.fs.readFile(this.resolve(relativePath));
    return new TextDecoder().decode(bytes);
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const resolved = resolveWorkspacePath(relativePath, this.roots, this.primaryRootName);
    const uri = vscode.Uri.file(resolved.absolutePath);
    let previousContent: string | undefined;
    try {
      previousContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      previousContent = undefined;
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
      throw new Error('run_command supports single-line commands only in integrated terminal mode');
    }
    if (this.runCommandSandboxConfigurationError) {
      throw new Error(this.runCommandSandboxConfigurationError);
    }

    const terminalOptions: vscode.TerminalOptions & { strictEnv?: boolean } = {
      name: RUN_COMMAND_TERMINAL_NAME,
      cwd: this.runCommandCwd,
      isTransient: true,
    };
    if (Object.keys(this.runCommandEnv).length > 0) {
      terminalOptions.env = this.runCommandEnv;
    }
    if (this.runCommandStrictEnv) {
      terminalOptions.strictEnv = true;
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show(true);

    const shellIntegration = await this.waitForShellIntegration(terminal);
    const execution = shellIntegration.executeCommand(command);
    const outputCapture = this.captureExecutionOutput(execution);
    const effectiveTimeoutMs = resolveCommandTimeoutMs(timeoutMs, this.runCommandTimeoutPolicy);

    try {
      const exitCode = await this.waitForExecutionExit(execution, effectiveTimeoutMs);
      await Promise.race([outputCapture.finished, this.delay(OUTPUT_FLUSH_GRACE_MS)]);
      return {
        stdout: sanitizeTerminalOutput(outputCapture.getOutput()).trim(),
        stderr: '',
        exitCode,
      };
    } catch (error) {
      terminal.sendText('\u0003', false);
      throw error;
    } finally {
      outputCapture.stop();
      terminal.dispose();
    }
  }

  private waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        integrationDisposable.dispose();
        closeDisposable.dispose();
        clearTimeout(timeoutHandle);
      };
      const settle = (finalizer: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        finalizer();
      };

      const integrationDisposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal !== terminal) {
          return;
        }
        settle(() => resolve(event.shellIntegration));
      });
      const closeDisposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal !== terminal) {
          return;
        }
        settle(() => reject(new Error('integrated terminal closed before shell integration activated')));
      });
      const timeoutHandle = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `shell integration did not activate within ${this.shellIntegrationTimeoutMs}ms; cannot run command in integrated terminal`
            )
          )
        );
      }, this.shellIntegrationTimeoutMs);
    });
  }

  private waitForExecutionExit(
    execution: vscode.TerminalShellExecution,
    timeoutMs: number
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        endDisposable.dispose();
        clearTimeout(timeoutHandle);
      };
      const settle = (finalizer: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        finalizer();
      };

      const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) {
          return;
        }
        settle(() => resolve(event.exitCode ?? 1));
      });
      const timeoutHandle = setTimeout(() => {
        settle(() => reject(new Error(`command timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    });
  }

  private captureExecutionOutput(execution: vscode.TerminalShellExecution): {
    getOutput: () => string;
    finished: Promise<void>;
    stop: () => void;
  } {
    let output = '';
    let stopped = false;
    const finished = (async () => {
      for await (const chunk of execution.read()) {
        if (stopped || chunk.length === 0 || output.length >= EXEC_MAX_BUFFER) {
          continue;
        }
        const remaining = EXEC_MAX_BUFFER - output.length;
        output += chunk.slice(0, remaining);
      }
    })().catch(() => {
      // Ignore stream errors here; exit code is resolved independently.
    });
    return {
      getOutput: () => output,
      finished,
      stop: () => {
        stopped = true;
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
