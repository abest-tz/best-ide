import { diffLines } from 'diff';
import * as vscode from 'vscode';
import { Agent, DEFAULT_SYSTEM_PROMPT, type ChatClient, type StepLimitContext } from '../core/agent';
import { OpenAIClient } from '../core/client';
import { createTools, parseToolArguments } from '../core/tools';
import type { ChatMessage, ToolCall } from '../core/types';
import type { ChatMode, ToExtensionMessage, ToWebviewMessage } from '../shared/protocol';
import {
  getBackendsForOperation,
  resolveBackendRouting,
  resolveChatModel,
  resolveEmbeddingModel,
  type BackendProfile,
  type BackendRoutingState,
} from './backendRouting';
import {
  buildComposerExecutionPrompt as buildComposerExecutionPromptText,
  buildComposerPlanMessages,
  formatComposerPlan,
  parseComposerPlan,
} from './composerMode';
import {
  parseContextMentions,
  type ContextFileMention,
  type ContextMention,
  type ContextSkillMention,
} from './contextMentions';
import { ConversationThreadStore, type StoredThread } from './conversationThreads';
import { VsCodeWorkspaceHost, type StagedWrite } from './host';
import {
  applyInlineEditToContent,
  buildInlineEditMessages,
  normalizeInlineEditResponse,
} from './inlineEdit';
import { normalizeMcpServerConfigs, type McpServerConfig } from './mcpClient';
import {
  RUN_COMMAND_TIMEOUT_DEFAULT_MS,
  RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS,
  normalizeRunCommandSandboxSettings,
} from './runCommandSandbox';
import { resolveSkillFile } from './skills';
import {
  formatTelemetrySummary,
  TelemetryRecorder,
  type RunOutcome,
} from './telemetry';

interface Config {
  model: string;
  backendRouting: BackendRoutingState;
  mcpServers: Record<string, McpServerConfig>;
  mcpRequestTimeoutMs: number;
  runCommandAllowlist: string[];
  runCommandDenylist: string[];
  runCommandCwd?: string;
  runCommandEnv: Record<string, string>;
  runCommandInheritEnv: boolean;
  runCommandTimeoutMs: number;
  runCommandMaxTimeoutMs: number;
  chatMode: ChatMode;
  temperature: number;
  autoApprove: boolean;
  maxSteps: number;
  telemetryEnabled: boolean;
}

function parseChatMode(value: string | undefined): ChatMode {
  if (value === 'ask') {
    return 'ask';
  }
  if (value === 'composer') {
    return 'composer';
  }
  return 'agent';
}

function parseStringListSetting(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function readConfig(): Config {
  const config = vscode.workspace.getConfiguration('bestIde');
  const baseUrl = config.get<string>('baseUrl', 'http://localhost:1234/v1');
  const apiKey = config.get<string>('apiKey', '');
  const model = config.get<string>('model', '');
  const embeddingModel = config.get<string>('embeddingModel', '');
  const inlineCompletionsModel = config.get<string>('inlineCompletions.model', '');
  const mcpRequestTimeoutMs = config.get<number>('mcp.requestTimeoutMs', 15_000);
  const runCommandSandbox = normalizeRunCommandSandboxSettings({
    cwd: config.get<unknown>('runCommand.cwd', ''),
    env: config.get<unknown>('runCommand.env', {}),
    inheritEnv: config.get<unknown>('runCommand.inheritEnv', true),
    timeoutMs: config.get<unknown>('runCommand.timeoutMs', RUN_COMMAND_TIMEOUT_DEFAULT_MS),
    maxTimeoutMs: config.get<unknown>('runCommand.maxTimeoutMs', RUN_COMMAND_TIMEOUT_MAX_DEFAULT_MS),
  });
  return {
    model,
    backendRouting: resolveBackendRouting({
      baseUrl,
      apiKey,
      model,
      embeddingModel,
      inlineCompletionsModel,
      backends: config.get<unknown>('backends', {}),
      backendPreset: config.get<unknown>('backendPreset', 'local'),
      backendRouting: config.get<unknown>('backendRouting', {}),
      modelRouting: config.get<unknown>('modelRouting', {}),
    }),
    mcpServers: normalizeMcpServerConfigs(config.get<unknown>('mcp.servers', {})),
    mcpRequestTimeoutMs: Number.isFinite(mcpRequestTimeoutMs)
      ? Math.max(1_000, Math.min(120_000, Math.floor(mcpRequestTimeoutMs)))
      : 15_000,
    runCommandAllowlist: parseStringListSetting(config.get<unknown>('runCommand.allowlist', [])),
    runCommandDenylist: parseStringListSetting(config.get<unknown>('runCommand.denylist', [])),
    runCommandCwd: runCommandSandbox.cwd,
    runCommandEnv: runCommandSandbox.env,
    runCommandInheritEnv: runCommandSandbox.inheritEnv,
    runCommandTimeoutMs: runCommandSandbox.timeoutMs,
    runCommandMaxTimeoutMs: runCommandSandbox.maxTimeoutMs,
    chatMode: parseChatMode(config.get<string>('chatMode', 'agent')),
    temperature: config.get<number>('temperature', 0.2),
    autoApprove: config.get<boolean>('autoApprove', false),
    maxSteps: config.get<number>('maxSteps', 25),
    telemetryEnabled: config.get<boolean>('telemetry.enabled', false),
  };
}

const RULES_FILE = '.bestide/rules.md';
const MENTION_FILE_MAX_CHARS = 16_000;
const MENTION_FOLDER_MAX_ENTRIES = 200;
const MENTION_SYMBOL_MAX_CHARS = 8_000;
const MENTION_SKILL_MAX_CHARS = 12_000;
const THREAD_EXPORT_BASENAME = 'bestide-conversation';

interface PendingChange {
  id: string;
  path: string;
  turnId: number;
  targetUri: vscode.Uri;
  previousContent: string | undefined;
  proposedContent: string;
}

interface CheckpointEntry {
  targetUri: vscode.Uri;
  previousContent: string | undefined;
}

function firstChangedLine(oldContent: string, newContent: string): number {
  const parts = diffLines(oldContent, newContent);
  let line = 0;
  for (const part of parts) {
    if (part.added || part.removed) {
      return Math.max(0, line);
    }
    line += part.count ?? part.value.split('\n').length;
  }
  return 0;
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated]`;
}

function sanitizeFilename(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || THREAD_EXPORT_BASENAME;
}

export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider
{
  public static readonly viewType = 'bestIde.chatView';
  public static readonly pendingScheme = 'bestide-pending';

  private view: vscode.WebviewView | undefined;
  private agent: Agent | undefined;
  private abortController: AbortController | undefined;
  private resolvedModel = '';
  private agentRootPath = '';
  private agentThreadId: string | undefined;
  private agentMode: ChatMode | undefined;
  private agentConfigFingerprint = '';
  private activeThreadId: string;
  private activeTurnId: number | undefined;
  private turnCounter = 0;
  private stepLimitRequestCounter = 0;
  private focusComposerPending = false;
  private readonly threadStore: ConversationThreadStore;
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly pendingStepLimitRequests = new Map<string, (continueRun: boolean) => void>();
  private readonly pendingToolTelemetry = new Map<string, { name: string; startedAtMs: number }>();
  private readonly pendingChanges = new Map<string, PendingChange>();
  private readonly checkpointsByTurn = new Map<number, Map<string, CheckpointEntry>>();
  private readonly checkpointOrder: number[] = [];
  private readonly pendingContentEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly telemetry: TelemetryRecorder;
  readonly onDidChange = this.pendingContentEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri
  ) {
    this.threadStore = new ConversationThreadStore(context.workspaceState);
    this.activeThreadId = this.threadStore.getActiveThread().id;
    this.telemetry = new TelemetryRecorder(context.globalState, {
      enabled: readConfig().telemetryEnabled,
    });
    this.updateCommandContexts();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const path = this.decodePendingPath(uri);
    const pending = this.pendingChanges.get(path);
    if (!pending) {
      return '';
    }
    const kind = new URLSearchParams(uri.query).get('kind');
    return kind === 'base' ? pending.previousContent ?? '' : pending.proposedContent;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: ToExtensionMessage) => {
      void this.onMessage(message);
    });
  }

  newChat(): void {
    this.cancel();
    this.agent = undefined;
    this.agentRootPath = '';
    this.agentThreadId = undefined;
    this.agentMode = undefined;
    this.agentConfigFingerprint = '';
    void this.createAndActivateThread();
  }

  public async focusChatComposer(): Promise<void> {
    this.focusComposerPending = true;
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.flushFocusComposerRequest();
  }

  public async searchThreads(): Promise<void> {
    if (this.abortController) {
      void vscode.window.showInformationMessage('Stop the current run before switching conversation threads.');
      return;
    }
    const summaries = this.threadStore.listThreads();
    const picked = await vscode.window.showQuickPick(
      summaries.map((thread) => ({
        label: thread.title,
        description: new Date(thread.updatedAt).toLocaleString(),
        detail: thread.preview,
        id: thread.id,
      })),
      {
        placeHolder: 'Search conversation threads',
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    if (!picked || picked.id === this.activeThreadId) {
      return;
    }
    const thread = await this.threadStore.setActiveThread(picked.id);
    if (!thread) {
      void vscode.window.showErrorMessage('Could not load the selected conversation thread.');
      return;
    }
    await this.activateThread(thread);
    this.post({ type: 'notice', text: `Loaded conversation: ${thread.title}` });
  }

  public async exportActiveThread(): Promise<void> {
    const thread = this.threadStore.getActiveThread();
    const format = await vscode.window.showQuickPick(
      [
        { label: 'Markdown (.md)', value: 'markdown' as const },
        { label: 'JSON (.json)', value: 'json' as const },
      ],
      { placeHolder: 'Export conversation format' }
    );
    if (!format) {
      return;
    }
    const extension = format.value === 'markdown' ? 'md' : 'json';
    const rootUri = this.getWorkspaceRoot();
    const defaultUri = rootUri
      ? vscode.Uri.joinPath(rootUri, `${sanitizeFilename(thread.title || THREAD_EXPORT_BASENAME)}.${extension}`)
      : undefined;
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: 'Export Conversation',
      filters: format.value === 'markdown' ? { Markdown: ['md'] } : { JSON: ['json'] },
    });
    if (!destination) {
      return;
    }

    const payload =
      format.value === 'markdown'
        ? this.threadStore.exportThreadAsMarkdown(thread.id)
        : this.threadStore.exportThreadAsJson(thread.id);
    if (!payload) {
      void vscode.window.showErrorMessage('Could not export the active conversation thread.');
      return;
    }
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(payload));
    void vscode.window.showInformationMessage(`Exported conversation to ${destination.fsPath}`);
  }

  public async showTelemetrySummary(): Promise<void> {
    const config = readConfig();
    this.telemetry.setEnabled(config.telemetryEnabled);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: formatTelemetrySummary(this.telemetry.getSummary()),
    });
    await vscode.window.showTextDocument(document, { preview: false });
    if (!config.telemetryEnabled) {
      void vscode.window.showInformationMessage(
        'Telemetry collection is disabled. Enable bestIde.telemetry.enabled to collect new metrics.'
      );
    }
  }

  public async resetTelemetry(): Promise<void> {
    await this.telemetry.reset();
    void vscode.window.showInformationMessage('Best IDE telemetry metrics have been reset.');
  }

  public async runInlineEdit(editor?: vscode.TextEditor): Promise<void> {
    if (this.abortController) {
      void vscode.window.showInformationMessage('Stop the current run before starting an inline edit.');
      return;
    }

    const targetEditor = editor ?? vscode.window.activeTextEditor;
    if (!targetEditor) {
      void vscode.window.showInformationMessage('Open a file and select code before starting an inline edit.');
      return;
    }

    const document = targetEditor.document;
    if (document.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(document.uri)) {
      void vscode.window.showInformationMessage('Inline edit works only for files inside the current workspace.');
      return;
    }

    const selection = targetEditor.selection;
    if (selection.isEmpty) {
      void vscode.window.showInformationMessage('Select code before starting an inline edit.');
      return;
    }
    const initialDocumentVersion = document.version;

    const instructionInput = await vscode.window.showInputBox({
      prompt: 'Describe how to edit the selected code',
      placeHolder: 'Example: simplify this function and keep behavior unchanged',
      ignoreFocusOut: true,
    });
    if (instructionInput === undefined) {
      return;
    }

    const instruction = instructionInput.trim();
    if (instruction === '') {
      void vscode.window.showInformationMessage('Inline edit instruction cannot be empty.');
      return;
    }

    const config = readConfig();
    if (config.chatMode === 'ask') {
      void vscode.window.showInformationMessage(
        'Inline edit is unavailable in Ask mode. Switch to Agent mode to edit files.'
      );
      return;
    }

    if (!this.resolvedModel) {
      await this.sendModels('modelsUpdated');
      if (!this.resolvedModel) {
        this.post({ type: 'error', message: 'No model available. Check your configured model backends.' });
        return;
      }
    }

    const selectedCode = document.getText(selection);
    const relativePath = vscode.workspace.asRelativePath(document.uri, false).replaceAll('\\', '/');
    const requestAbort = new AbortController();
    this.abortController = requestAbort;
    this.post({ type: 'busy', value: true });

    try {
      const response = await this.createRoutedChatClient(config, 'agent').chat(
        {
          model: this.resolvedModel,
          messages: buildInlineEditMessages({
            filePath: relativePath,
            languageId: document.languageId,
            instruction,
            selection: selectedCode,
          }),
          temperature: config.temperature,
          signal: requestAbort.signal,
        },
        () => {
          // Inline edit responses are applied as a single replacement, so we ignore streaming deltas.
        }
      );
      const replacement = normalizeInlineEditResponse(response.content);
      if (replacement === '') {
        throw new Error('model returned an empty inline edit result');
      }
      if (document.version !== initialDocumentVersion) {
        throw new Error('document changed while inline edit was running; retry with a fresh selection');
      }

      const previousContent = document.getText();
      const nextContent = applyInlineEditToContent(
        previousContent,
        {
          startOffset: document.offsetAt(selection.start),
          endOffset: document.offsetAt(selection.end),
        },
        replacement
      );
      if (nextContent === previousContent) {
        this.post({ type: 'notice', text: `Inline edit for ${relativePath} produced no changes.` });
        return;
      }

      const inlineTurnId = ++this.turnCounter;
      const priorTurnId = this.activeTurnId;
      this.activeTurnId = inlineTurnId;
      try {
        await this.stagePendingChange({
          targetUri: document.uri,
          path: relativePath,
          previousContent,
          content: nextContent,
        });
      } finally {
        this.activeTurnId = priorTurnId;
      }
      this.post({
        type: 'notice',
        text: `Inline edit staged for ${relativePath}. Review it in the diff editor and accept or reject.`,
      });
    } catch (error) {
      if (requestAbort.signal.aborted) {
        this.post({ type: 'notice', text: 'Cancelled.' });
      } else {
        this.post({
          type: 'error',
          message: `Inline edit failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      if (this.abortController === requestAbort) {
        this.abortController = undefined;
      }
      this.post({ type: 'busy', value: false });
    }
  }

  private async createAndActivateThread(): Promise<void> {
    try {
      const thread = await this.threadStore.createThread();
      await this.activateThread(thread);
      this.post({ type: 'notice', text: 'Started a new conversation thread.' });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not create a new conversation thread: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async activateThread(thread: StoredThread): Promise<void> {
    this.activeThreadId = thread.id;
    this.agent = undefined;
    this.agentRootPath = '';
    this.agentThreadId = undefined;
    this.agentMode = undefined;
    this.agentConfigFingerprint = '';
    this.postActiveThread(thread);
    this.replayPendingChanges();
    this.updateCommandContexts();
  }

  private postActiveThread(thread?: StoredThread): void {
    const active = thread ?? this.threadStore.getActiveThread();
    this.activeThreadId = active.id;
    this.post({ type: 'threadLoaded', id: active.id, title: active.title, transcript: active.transcript });
    this.updateCommandContexts();
  }

  async pickModelViaQuickPick(): Promise<void> {
    const config = readConfig();
    try {
      const { models, backend } = await this.listModelsFromBackends(config);
      const picked = await vscode.window.showQuickPick(
        models.map((m) => m.id),
        { placeHolder: `Select a model (${backend.id})` }
      );
      if (picked) {
        await this.setModel(picked);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not list models from configured backends: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private post(message: ToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private flushFocusComposerRequest(): void {
    if (!this.focusComposerPending || !this.view) {
      return;
    }
    this.focusComposerPending = false;
    this.post({ type: 'focusComposer' });
  }

  private async onMessage(message: ToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendModels('init');
        this.postActiveThread();
        this.replayPendingChanges();
        this.flushFocusComposerRequest();
        break;
      case 'refreshModels':
        await this.sendModels('modelsUpdated');
        break;
      case 'send':
        await this.handleSend(message.text);
        break;
      case 'approvalResponse': {
        const resolve = this.pendingApprovals.get(message.id);
        if (resolve) {
          this.pendingApprovals.delete(message.id);
          resolve(message.approved);
        }
        break;
      }
      case 'stepLimitResponse': {
        const resolve = this.pendingStepLimitRequests.get(message.id);
        if (resolve) {
          this.pendingStepLimitRequests.delete(message.id);
          resolve(message.continueRun);
          this.post({ type: 'stepLimitResolved', id: message.id, continued: message.continueRun });
        }
        break;
      }
      case 'pendingChangeDecision':
        if (message.accepted) {
          await this.acceptAgentChangeById(message.id);
        } else {
          this.rejectAgentChangeById(message.id);
        }
        break;
      case 'acceptAllPendingChanges':
        await this.acceptAllAgentChanges();
        break;
      case 'revertLastTurn':
        await this.revertLastAgentTurn();
        break;
      case 'pickModel':
        await this.setModel(message.model);
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'setMode':
        await this.setChatMode(message.mode);
        break;
      case 'cancel':
        this.cancel();
        break;
    }
  }

  private cancel(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.pendingToolTelemetry.clear();
    for (const [id, resolve] of this.pendingApprovals) {
      resolve(false);
      this.post({ type: 'approvalResolved', id, approved: false });
    }
    this.pendingApprovals.clear();
    for (const [id, resolve] of this.pendingStepLimitRequests) {
      resolve(false);
      this.post({ type: 'stepLimitResolved', id, continued: false });
    }
    this.pendingStepLimitRequests.clear();
    this.post({ type: 'busy', value: false });
  }

  private async setModel(model: string): Promise<void> {
    this.resolvedModel = model;
    // Model changes invalidate the agent (next send recreates it); history is per-model for MVP.
    this.agent = undefined;
    this.agentThreadId = undefined;
    this.agentMode = undefined;
    this.agentConfigFingerprint = '';
    await vscode.workspace
      .getConfiguration('bestIde')
      .update('model', model, vscode.ConfigurationTarget.Global);
    await this.sendModels('modelsUpdated');
  }

  private async setChatMode(mode: ChatMode): Promise<void> {
    if (this.abortController) {
      void vscode.window.showInformationMessage('Stop the current run before switching chat modes.');
      return;
    }
    const normalized = parseChatMode(mode);
    const config = readConfig();
    if (config.chatMode !== normalized) {
      await vscode.workspace
        .getConfiguration('bestIde')
        .update('chatMode', normalized, vscode.ConfigurationTarget.Global);
    }
    this.agent = undefined;
    this.agentRootPath = '';
    this.agentThreadId = undefined;
    this.agentMode = undefined;
    this.agentConfigFingerprint = '';
    this.post({ type: 'modeChanged', mode: normalized });
    const modeNotice =
      normalized === 'ask'
        ? 'Ask mode enabled: the assistant is now read-only (no file edits or command execution).'
        : normalized === 'composer'
          ? 'Composer mode enabled: the assistant drafts a structured plan, then applies edits across multiple files.'
          : 'Agent mode enabled: the assistant can use editing and command tools.';
    this.post({
      type: 'notice',
      text: modeNotice,
    });
  }

  private formatBackendError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async listModelsFromBackends(config: Config): Promise<{
    models: Array<{ id: string }>;
    backend: BackendProfile;
    failures: string[];
  }> {
    const failures: string[] = [];
    const modelBackends = getBackendsForOperation(config.backendRouting, 'models');
    for (const backend of modelBackends) {
      const client = new OpenAIClient({ baseUrl: backend.baseUrl, apiKey: backend.apiKey });
      try {
        const models = await client.listModels();
        return { models, backend, failures };
      } catch (error) {
        failures.push(`${backend.id}: ${this.formatBackendError(error)}`);
      }
    }
    throw new Error(
      failures.length > 0 ? failures.join('\n') : 'No configured backend is available for model discovery.'
    );
  }

  private createRoutedChatClient(config: Config, mode: ChatMode = config.chatMode): ChatClient {
    const chatBackends = getBackendsForOperation(config.backendRouting, 'chat');
    const primaryBackendId = chatBackends[0]?.id;
    let fallbackNoticeShown = false;
    this.telemetry.setEnabled(config.telemetryEnabled);
    return {
      chat: async (options, onText) => {
        const failures: string[] = [];
        for (const backend of chatBackends) {
          const preferredModel = resolveChatModel(config.backendRouting, backend, mode, options.model);
          const modelCandidates = [preferredModel, backend.model].filter(
            (model, index, all) => model !== '' && all.indexOf(model) === index
          );
          if (modelCandidates.length === 0) {
            failures.push(`${backend.id}: no model configured`);
            continue;
          }
          const client = new OpenAIClient({ baseUrl: backend.baseUrl, apiKey: backend.apiKey });
          for (const model of modelCandidates) {
            let streamed = false;
            const startedAtMs = Date.now();
            try {
              const turn = await client.chat(
                {
                  ...options,
                  model,
                },
                (delta) => {
                  streamed = true;
                  onText(delta);
                }
              );
              this.telemetry.recordModelTurn({
                backendId: backend.id,
                model,
                success: true,
                latencyMs: Date.now() - startedAtMs,
              });
              if (backend.id !== primaryBackendId && !fallbackNoticeShown) {
                fallbackNoticeShown = true;
                this.post({
                  type: 'notice',
                  text: `Primary backend unavailable; using fallback backend "${backend.id}".`,
                });
              }
              return turn;
            } catch (error) {
              this.telemetry.recordModelTurn({
                backendId: backend.id,
                model,
                success: false,
                latencyMs: Date.now() - startedAtMs,
              });
              if (streamed) {
                throw new Error(
                  `Backend "${backend.id}" failed after streaming began: ${this.formatBackendError(error)}`
                );
              }
              failures.push(`${backend.id} (${model}): ${this.formatBackendError(error)}`);
            }
          }
        }
        throw new Error(
          failures.length > 0
            ? `Chat failed across configured backends:\n${failures.join('\n')}`
            : 'No configured backend is available for chat requests.'
        );
      },
    };
  }

  private async sendModels(kind: 'init' | 'modelsUpdated'): Promise<void> {
    const config = readConfig();
    try {
      const { models, backend, failures } = await this.listModelsFromBackends(config);
      const preferredModel = resolveChatModel(
        config.backendRouting,
        backend,
        config.chatMode,
        config.model
      );
      const model =
        preferredModel && models.some((m) => m.id === preferredModel)
          ? preferredModel
          : config.model && models.some((m) => m.id === config.model)
            ? config.model
          : (models[0]?.id ?? '');
      this.resolvedModel = model;
      this.post({ type: kind, models, model, mode: config.chatMode, connected: true });
      if (failures.length > 0) {
        this.post({
          type: 'notice',
          text: `Model discovery fell back to backend "${backend.id}" after: ${failures.join('; ')}`,
        });
      }
    } catch (error) {
      this.post({
        type: kind,
        models: [],
        model: '',
        mode: config.chatMode,
        connected: false,
        error: `Could not reach any configured backend.\n${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  private getWorkspaceRoot(): vscode.Uri | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder.uri;
      }
    }
    return this.getWorkspaceFolders()[0]?.uri;
  }

  private createWorkspaceHost(
    root: vscode.Uri,
    config: Config,
    onWriteFile?: (change: StagedWrite) => Promise<void>
  ): VsCodeWorkspaceHost {
    const workspaceFolders = this.getWorkspaceFolders();
    const hasMcpServers = Object.keys(config.mcpServers).length > 0;
    const embeddingBackend =
      getBackendsForOperation(config.backendRouting, 'embeddings')[0] ?? config.backendRouting.backends[0];
    const embeddingModel = embeddingBackend
      ? resolveEmbeddingModel(config.backendRouting, embeddingBackend)
      : '';
    return new VsCodeWorkspaceHost(root, {
      ...(onWriteFile ? { onWriteFile } : {}),
      ...(workspaceFolders.length > 0 ? { workspaceFolders } : {}),
      semanticSearch: {
        baseUrl: embeddingBackend?.baseUrl ?? 'http://localhost:1234/v1',
        apiKey: embeddingBackend?.apiKey ?? '',
        model: embeddingModel,
      },
      runCommand: {
        allowlist: config.runCommandAllowlist,
        denylist: config.runCommandDenylist,
        cwd: config.runCommandCwd,
        env: config.runCommandEnv,
        inheritEnv: config.runCommandInheritEnv,
        timeoutMs: config.runCommandTimeoutMs,
        maxTimeoutMs: config.runCommandMaxTimeoutMs,
      },
      ...(hasMcpServers
        ? {
            mcp: {
              servers: config.mcpServers,
              requestTimeoutMs: config.mcpRequestTimeoutMs,
            },
          }
        : {}),
    });
  }

  private async buildPromptFromMentions(
    text: string,
    host: VsCodeWorkspaceHost
  ): Promise<{ prompt: string; notices: string[] }> {
    const parsed = parseContextMentions(text);
    const notices: string[] = [];
    const sections: string[] = [];

    for (const malformed of parsed.malformedMentions) {
      notices.push(
        `Couldn't parse context mention ${malformed}. Use @file:path[:start-end], @folder:path, @symbol:query, or @skill:name.`
      );
    }

    for (const mention of parsed.mentions) {
      try {
        sections.push(await this.buildMentionSection(mention, host));
      } catch (error) {
        notices.push(
          `Skipped context mention ${mention.raw}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const body = parsed.promptWithoutMentions.trim() || text.trim();
    if (sections.length === 0) {
      return { prompt: body, notices };
    }

    const prompt = `[Context from @ mentions]\n\n${sections.join('\n\n')}\n\n${
      body || 'Use the referenced context above.'
    }`;
    return { prompt, notices };
  }

  private async buildMentionSection(
    mention: ContextMention,
    host: VsCodeWorkspaceHost
  ): Promise<string> {
    switch (mention.kind) {
      case 'file':
        return this.buildFileMentionSection(mention, host);
      case 'folder':
        return this.buildFolderMentionSection(mention, host);
      case 'symbol':
        return this.buildSymbolMentionSection(mention, host);
      case 'skill':
        return this.buildSkillMentionSection(mention, host);
    }
  }

  private async buildFileMentionSection(
    mention: ContextFileMention,
    host: VsCodeWorkspaceHost
  ): Promise<string> {
    const content = await host.readFile(mention.path);
    let excerpt = content;
    let label = mention.path;

    if (mention.lineStart !== undefined && mention.lineEnd !== undefined) {
      const lines = content.split('\n');
      if (mention.lineStart > lines.length) {
        throw new Error(`line range ${mention.lineStart}-${mention.lineEnd} is outside file bounds`);
      }
      const boundedEnd = Math.min(mention.lineEnd, lines.length);
      excerpt = lines.slice(mention.lineStart - 1, boundedEnd).join('\n');
      label = `${mention.path}:${mention.lineStart}-${boundedEnd}`;
    }

    return `[File: ${label}]\n\`\`\`\n${truncateForPrompt(excerpt, MENTION_FILE_MAX_CHARS)}\n\`\`\``;
  }

  private async buildFolderMentionSection(
    mention: Extract<ContextMention, { kind: 'folder' }>,
    host: VsCodeWorkspaceHost
  ): Promise<string> {
    const entries = await host.listDir(mention.path);
    const lines = entries
      .slice(0, MENTION_FOLDER_MAX_ENTRIES)
      .map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name));
    if (entries.length > MENTION_FOLDER_MAX_ENTRIES) {
      lines.push('... [truncated]');
    }
    const body = lines.length > 0 ? lines.join('\n') : '(folder is empty)';
    return `[Folder: ${mention.path}]\n\`\`\`\n${body}\n\`\`\``;
  }

  private async buildSymbolMentionSection(
    mention: Extract<ContextMention, { kind: 'symbol' }>,
    host: VsCodeWorkspaceHost
  ): Promise<string> {
    const symbols = await host.getSymbols(mention.query);
    return `[Symbols: ${mention.query}]\n\`\`\`\n${truncateForPrompt(
      symbols,
      MENTION_SYMBOL_MAX_CHARS
    )}\n\`\`\``;
  }

  private async buildSkillMentionSection(
    mention: ContextSkillMention,
    host: VsCodeWorkspaceHost
  ): Promise<string> {
    const skill = await resolveSkillFile(mention.name, (path) => host.readFile(path));
    return `[Skill: ${skill.name} (${skill.path})]\n\`\`\`\n${truncateForPrompt(
      skill.content,
      MENTION_SKILL_MAX_CHARS
    )}\n\`\`\``;
  }

  private async buildComposerPrompt(
    prompt: string,
    config: Config,
    signal: AbortSignal
  ): Promise<string> {
    const plannerTurn = await this.createRoutedChatClient(config, 'composer').chat(
      {
        model: this.resolvedModel,
        messages: buildComposerPlanMessages(prompt),
        temperature: config.temperature,
        signal,
      },
      () => {
        // Composer planning is surfaced once we have the complete structured plan.
      }
    );
    const plan = parseComposerPlan(plannerTurn.content, prompt);
    this.post({ type: 'notice', text: `Composer plan ready.\n${formatComposerPlan(plan)}` });
    return buildComposerExecutionPromptText(prompt, plan);
  }

  private async handleSend(text: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.post({ type: 'error', message: 'Open a folder to use the agent.' });
      return;
    }
    if (!this.resolvedModel) {
      await this.sendModels('modelsUpdated');
      if (!this.resolvedModel) {
        this.post({ type: 'error', message: 'No model available. Check your configured model backends.' });
        return;
      }
    }

    const config = readConfig();
    this.telemetry.setEnabled(config.telemetryEnabled);
    const configFingerprint = JSON.stringify(config);
    const activeThread = this.threadStore.getActiveThread();
    if (
      !this.agent ||
      this.agentRootPath !== root.fsPath ||
      this.agentThreadId !== activeThread.id ||
      this.agentMode !== config.chatMode ||
      this.agentConfigFingerprint !== configFingerprint
    ) {
      const systemPrompt = await this.buildSystemPrompt(root);
      this.agent = new Agent({
        client: this.createRoutedChatClient(config),
        host: this.createWorkspaceHost(root, config, async (change) => this.stagePendingChange(change)),
        tools: createTools(config.chatMode),
        model: this.resolvedModel,
        temperature: config.temperature,
        maxSteps: config.maxSteps,
        autoApprove: config.autoApprove,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(activeThread.messages.length > 0 ? { initialMessages: activeThread.messages } : {}),
      });
      this.agentRootPath = root.fsPath;
      this.agentThreadId = activeThread.id;
      this.agentMode = config.chatMode;
      this.agentConfigFingerprint = configFingerprint;
    }
    const historyLengthBeforeRun = this.agent.messages.length;

    const mentionContext = await this.buildPromptFromMentions(text, this.createWorkspaceHost(root, config));
    for (const notice of mentionContext.notices) {
      this.post({ type: 'notice', text: notice });
    }
    const prompt = mentionContext.prompt.trim() || text;

    const turnId = ++this.turnCounter;
    this.activeTurnId = turnId;
    const requestAbort = new AbortController();
    this.abortController = requestAbort;
    this.pendingToolTelemetry.clear();
    this.post({ type: 'busy', value: true });
    let runOutcome: RunOutcome | undefined;

    try {
      const runPrompt =
        config.chatMode === 'composer'
          ? await this.buildComposerPrompt(prompt, config, requestAbort.signal)
          : prompt;
      await this.agent.run(
        runPrompt,
        {
          onAssistantText: (delta) => this.post({ type: 'assistantDelta', text: delta }),
          onToolCall: (call, mutating) => {
            this.pendingToolTelemetry.set(call.id, {
              name: call.function.name,
              startedAtMs: Date.now(),
            });
            this.post({
              type: 'toolCall',
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
              mutating,
            });
          },
          onToolResult: (callId, result) => {
            const pendingTelemetry = this.pendingToolTelemetry.get(callId);
            if (pendingTelemetry) {
              this.pendingToolTelemetry.delete(callId);
              this.telemetry.recordToolCall({
                name: pendingTelemetry.name,
                success: !result.startsWith('Error:'),
                latencyMs: Date.now() - pendingTelemetry.startedAtMs,
              });
            }
            this.post({ type: 'toolResult', id: callId, result });
          },
          requestApproval: (call) => this.requestApproval(call),
          onNotice: (notice) => this.post({ type: 'notice', text: notice }),
          requestStepLimitContinuation: (context) => this.requestStepLimitContinuation(context),
        },
        requestAbort.signal
      );
      runOutcome = 'completed';
      const assistantTexts = this.extractAssistantTexts(this.agent.messages.slice(historyLengthBeforeRun));
      const updatedThread = await this.threadStore.recordTurn(this.activeThreadId, {
        userText: text,
        assistantTexts,
        messages: this.agent.messages,
      });
      if (updatedThread) {
        this.activeThreadId = updatedThread.id;
        this.updateCommandContexts();
      }
    } catch (error) {
      if (requestAbort.signal.aborted) {
        runOutcome = 'cancelled';
        this.post({ type: 'notice', text: 'Cancelled.' });
      } else {
        runOutcome = 'failed';
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.post({
          type: 'error',
          message: errorMessage,
        });
        const updatedThread = await this.threadStore.recordFailedTurn(this.activeThreadId, {
          userText: text,
          errorMessage,
          messages: this.agent.messages,
        });
        if (updatedThread) {
          this.activeThreadId = updatedThread.id;
          this.updateCommandContexts();
        }
      }
    } finally {
      if (!runOutcome) {
        runOutcome = requestAbort.signal.aborted ? 'cancelled' : 'failed';
      }
      this.telemetry.recordRunOutcome(runOutcome);
      this.pendingToolTelemetry.clear();
      this.activeTurnId = undefined;
      if (this.abortController === requestAbort) {
        this.abortController = undefined;
      }
      this.post({ type: 'busy', value: false });
    }
  }

  private extractAssistantTexts(messages: readonly ChatMessage[]): string[] {
    const texts: string[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue;
      }
      const text = message.content.trim();
      if (!text) {
        continue;
      }
      texts.push(message.content);
    }
    return texts;
  }

  private async requestApproval(call: ToolCall): Promise<boolean> {
    if (call.function.name !== 'run_command') {
      return true;
    }

    let command: string | undefined;
    try {
      const args = parseToolArguments(call.function.arguments);
      command = typeof args['command'] === 'string' ? args['command'] : call.function.arguments;
    } catch {
      // Malformed args: still show the approval card with raw arguments.
    }

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(call.id, (approved) => {
        this.telemetry.recordCommandApproval(approved);
        this.post({ type: 'approvalResolved', id: call.id, approved });
        resolve(approved);
      });
      this.post({
        type: 'approvalRequest',
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
        ...(command !== undefined ? { command } : {}),
      });
    });
  }

  private async requestStepLimitContinuation(context: StepLimitContext): Promise<boolean> {
    const id = `step-limit-${++this.stepLimitRequestCounter}`;
    return new Promise<boolean>((resolve) => {
      this.pendingStepLimitRequests.set(id, resolve);
      this.post({
        type: 'stepLimitRequest',
        id,
        stepLimit: context.maxSteps,
        completedSteps: context.completedSteps,
      });
    });
  }

  public async acceptAgentChange(target?: vscode.Uri): Promise<void> {
    const pending = await this.resolvePendingChange(target);
    if (!pending) {
      void vscode.window.showInformationMessage('No pending agent change selected.');
      return;
    }
    await this.acceptAgentChangeById(pending.id);
  }

  public async rejectAgentChange(target?: vscode.Uri): Promise<void> {
    const pending = await this.resolvePendingChange(target);
    if (!pending) {
      void vscode.window.showInformationMessage('No pending agent change selected.');
      return;
    }
    this.rejectAgentChangeById(pending.id);
  }

  public async acceptAllAgentChanges(): Promise<void> {
    const all = [...this.pendingChanges.values()].sort(
      (a, b) => a.turnId - b.turnId || a.path.localeCompare(b.path)
    );
    for (const change of all) {
      await this.acceptAgentChangeById(change.id);
    }
    if (all.length > 0) {
      this.post({ type: 'notice', text: `Accepted ${all.length} pending agent change(s).` });
    }
  }

  public async revertLastAgentTurn(): Promise<void> {
    const turnId = this.checkpointOrder.pop();
    if (turnId === undefined) {
      void vscode.window.showInformationMessage('No accepted agent turn to revert.');
      return;
    }

    const checkpoint = this.checkpointsByTurn.get(turnId);
    if (!checkpoint) {
      this.updateCommandContexts();
      return;
    }

    for (const [, entry] of checkpoint) {
      const uri = entry.targetUri;
      if (entry.previousContent === undefined) {
        try {
          await vscode.workspace.fs.delete(uri);
        } catch {
          // Ignore missing files while reverting.
        }
        continue;
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(entry.previousContent));
    }

    this.checkpointsByTurn.delete(turnId);
    this.updateCommandContexts();
    this.post({ type: 'notice', text: `Reverted all accepted changes from turn ${turnId}.` });
  }

  private async buildSystemPrompt(root: vscode.Uri): Promise<string | undefined> {
    const workspaceFolders = this.getWorkspaceFolders();
    const roots =
      workspaceFolders.length > 0
        ? workspaceFolders.map((folder) => ({ label: folder.name, uri: folder.uri }))
        : [{ label: '', uri: root }];
    const sections: string[] = [];

    for (const workspaceRoot of roots) {
      const rulesUri = vscode.Uri.joinPath(workspaceRoot.uri, RULES_FILE);
      let rulesText = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(rulesUri);
        rulesText = new TextDecoder().decode(bytes).trim();
      } catch {
        continue;
      }
      if (!rulesText) {
        continue;
      }
      const source = workspaceRoot.label ? `${workspaceRoot.label}/${RULES_FILE}` : RULES_FILE;
      sections.push(`[Project rules from ${source}]\n${rulesText}`);
    }

    if (sections.length === 0) {
      return undefined;
    }

    return `${DEFAULT_SYSTEM_PROMPT}\n\n${sections.join('\n\n')}`;
  }

  private pendingUri(path: string, kind: 'base' | 'proposed'): vscode.Uri {
    return vscode.Uri.from({
      scheme: ChatViewProvider.pendingScheme,
      path: `/${encodeURIComponent(path)}`,
      query: `kind=${kind}`,
    });
  }

  private decodePendingPath(uri: vscode.Uri): string {
    const encoded = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    return decodeURIComponent(encoded);
  }

  private replayPendingChanges(): void {
    for (const pending of [...this.pendingChanges.values()].sort(
      (a, b) => a.turnId - b.turnId || a.path.localeCompare(b.path)
    )) {
      this.post({ type: 'pendingChange', id: pending.id, path: pending.path, turnId: pending.turnId });
    }
  }

  private async stagePendingChange(change: StagedWrite): Promise<void> {
    const turnId = this.activeTurnId ?? this.turnCounter;
    const existing = this.pendingChanges.get(change.path);
    const pending: PendingChange = {
      id: change.path,
      path: change.path,
      turnId,
      targetUri: change.targetUri,
      previousContent: existing?.previousContent ?? change.previousContent,
      proposedContent: change.content,
    };
    this.pendingChanges.set(change.path, pending);

    const baseUri = this.pendingUri(change.path, 'base');
    const proposedUri = this.pendingUri(change.path, 'proposed');
    this.pendingContentEmitter.fire(baseUri);
    this.pendingContentEmitter.fire(proposedUri);
    this.updateCommandContexts();
    this.post({ type: 'pendingChange', id: pending.id, path: pending.path, turnId: pending.turnId });

    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri,
      proposedUri,
      `Agent change: ${pending.path}`,
      { preview: false }
    );
    await vscode.commands.executeCommand('revealLine', {
      lineNumber: firstChangedLine(pending.previousContent ?? '', pending.proposedContent),
      at: 'center',
    });
  }

  private async resolvePendingChange(target?: vscode.Uri): Promise<PendingChange | undefined> {
    if (target?.scheme === ChatViewProvider.pendingScheme) {
      return this.pendingChanges.get(this.decodePendingPath(target));
    }

    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === ChatViewProvider.pendingScheme) {
      return this.pendingChanges.get(this.decodePendingPath(active));
    }

    if (this.pendingChanges.size === 0) {
      return undefined;
    }
    if (this.pendingChanges.size === 1) {
      return this.pendingChanges.values().next().value;
    }

    const picked = await vscode.window.showQuickPick(
      [...this.pendingChanges.values()]
        .sort((a, b) => a.turnId - b.turnId || a.path.localeCompare(b.path))
        .map((change) => ({
          label: change.path,
          description: `turn ${change.turnId}`,
          changeId: change.id,
        })),
      { placeHolder: 'Select a pending agent change' }
    );
    if (!picked) {
      return undefined;
    }
    return this.pendingChanges.get(picked.changeId);
  }

  private async acceptAgentChangeById(id: string): Promise<void> {
    const pending = this.pendingChanges.get(id);
    if (!pending) {
      return;
    }
    await vscode.workspace.fs.writeFile(pending.targetUri, new TextEncoder().encode(pending.proposedContent));
    this.recordCheckpoint(pending);
    this.resolvePendingChangeEntry(pending, true);
    await this.openAcceptedFile(pending);
  }

  private rejectAgentChangeById(id: string): void {
    const pending = this.pendingChanges.get(id);
    if (!pending) {
      return;
    }
    this.resolvePendingChangeEntry(pending, false);
  }

  private resolvePendingChangeEntry(pending: PendingChange, accepted: boolean): void {
    this.pendingChanges.delete(pending.id);
    this.telemetry.recordPendingChangeDecision(accepted);
    this.pendingContentEmitter.fire(this.pendingUri(pending.path, 'base'));
    this.pendingContentEmitter.fire(this.pendingUri(pending.path, 'proposed'));
    this.updateCommandContexts();
    this.post({ type: 'pendingChangeResolved', id: pending.id, accepted });
    this.post({
      type: 'notice',
      text: `${accepted ? 'Accepted' : 'Rejected'} agent change for ${pending.path}.`,
    });
  }

  private recordCheckpoint(pending: PendingChange): void {
    let checkpoint = this.checkpointsByTurn.get(pending.turnId);
    if (!checkpoint) {
      checkpoint = new Map<string, CheckpointEntry>();
      this.checkpointsByTurn.set(pending.turnId, checkpoint);
      this.checkpointOrder.push(pending.turnId);
    }
    if (!checkpoint.has(pending.path)) {
      checkpoint.set(pending.path, {
        targetUri: pending.targetUri,
        previousContent: pending.previousContent,
      });
    }
    this.updateCommandContexts();
  }

  private async openAcceptedFile(pending: PendingChange): Promise<void> {
    const uri = pending.targetUri;
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const maxLine = Math.max(0, document.lineCount - 1);
    const line = Math.min(maxLine, firstChangedLine(pending.previousContent ?? '', pending.proposedContent));
    const position = new vscode.Position(line, 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private updateCommandContexts(): void {
    const activeThread = this.threadStore.getActiveThread();
    void vscode.commands.executeCommand('setContext', 'bestIde.hasPendingChanges', this.pendingChanges.size > 0);
    void vscode.commands.executeCommand(
      'setContext',
      'bestIde.hasTurnCheckpoint',
      this.checkpointOrder.length > 0
    );
    void vscode.commands.executeCommand(
      'setContext',
      'bestIde.hasThreadTranscript',
      activeThread.transcript.length > 0
    );
    void vscode.commands.executeCommand(
      'setContext',
      'bestIde.hasMultipleThreads',
      this.threadStore.listThreads().length > 1
    );
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62))
    ).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Best IDE Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
