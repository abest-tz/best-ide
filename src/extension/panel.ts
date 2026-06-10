import { createTwoFilesPatch } from 'diff';
import * as vscode from 'vscode';
import { Agent } from '../core/agent';
import { OpenAIClient } from '../core/client';
import { parseToolArguments } from '../core/tools';
import type { ToolCall } from '../core/types';
import type { ToExtensionMessage, ToWebviewMessage } from '../shared/protocol';
import { VsCodeWorkspaceHost } from './host';

interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  autoApprove: boolean;
  maxSteps: number;
}

function readConfig(): Config {
  const config = vscode.workspace.getConfiguration('bestIde');
  return {
    baseUrl: config.get<string>('baseUrl', 'http://localhost:1234/v1'),
    apiKey: config.get<string>('apiKey', ''),
    model: config.get<string>('model', ''),
    temperature: config.get<number>('temperature', 0.2),
    autoApprove: config.get<boolean>('autoApprove', false),
    maxSteps: config.get<number>('maxSteps', 25),
  };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'bestIde.chatView';

  private view: vscode.WebviewView | undefined;
  private agent: Agent | undefined;
  private abortController: AbortController | undefined;
  private resolvedModel = '';
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private readonly extensionUri: vscode.Uri) {}

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
    this.post({ type: 'cleared' });
  }

  async pickModelViaQuickPick(): Promise<void> {
    const config = readConfig();
    const client = new OpenAIClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    try {
      const models = await client.listModels();
      const picked = await vscode.window.showQuickPick(
        models.map((m) => m.id),
        { placeHolder: 'Select a model' }
      );
      if (picked) {
        await this.setModel(picked);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not reach ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private post(message: ToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(message: ToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendModels('init');
        break;
      case 'refreshModels':
        await this.sendModels('modelsUpdated');
        break;
      case 'send':
        await this.handleSend(message.text, message.includeContext);
        break;
      case 'approvalResponse': {
        const resolve = this.pendingApprovals.get(message.id);
        if (resolve) {
          this.pendingApprovals.delete(message.id);
          resolve(message.approved);
        }
        break;
      }
      case 'pickModel':
        await this.setModel(message.model);
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'cancel':
        this.cancel();
        break;
    }
  }

  private cancel(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    for (const [id, resolve] of this.pendingApprovals) {
      resolve(false);
      this.post({ type: 'approvalResolved', id, approved: false });
    }
    this.pendingApprovals.clear();
    this.post({ type: 'busy', value: false });
  }

  private async setModel(model: string): Promise<void> {
    this.resolvedModel = model;
    // Model changes invalidate the agent (next send recreates it); history is per-model for MVP.
    this.agent = undefined;
    await vscode.workspace
      .getConfiguration('bestIde')
      .update('model', model, vscode.ConfigurationTarget.Global);
    await this.sendModels('modelsUpdated');
  }

  private async sendModels(kind: 'init' | 'modelsUpdated'): Promise<void> {
    const config = readConfig();
    const client = new OpenAIClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    try {
      const models = await client.listModels();
      const model =
        config.model && models.some((m) => m.id === config.model)
          ? config.model
          : (models[0]?.id ?? '');
      this.resolvedModel = model;
      this.post({ type: kind, models, model, connected: true });
    } catch (error) {
      this.post({
        type: kind,
        models: [],
        model: '',
        connected: false,
        error: `Could not reach ${config.baseUrl}. Is the LM Studio server running?\n${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private getWorkspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private async buildContextPreamble(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    const root = this.getWorkspaceRoot();
    if (!editor || !root) {
      return '';
    }
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const text = editor.document.getText(selection);
      return `[Context: the user has ${relative} open with lines ${selection.start.line + 1}-${
        selection.end.line + 1
      } selected:]\n\`\`\`\n${text}\n\`\`\`\n\n`;
    }
    return `[Context: the user has ${relative} open in the editor.]\n\n`;
  }

  private async handleSend(text: string, includeContext: boolean): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.post({ type: 'error', message: 'Open a folder to use the agent.' });
      return;
    }
    if (!this.resolvedModel) {
      await this.sendModels('modelsUpdated');
      if (!this.resolvedModel) {
        this.post({ type: 'error', message: 'No model available. Load a model in LM Studio first.' });
        return;
      }
    }

    const config = readConfig();
    if (!this.agent) {
      this.agent = new Agent({
        client: new OpenAIClient({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
        host: new VsCodeWorkspaceHost(root),
        model: this.resolvedModel,
        temperature: config.temperature,
        maxSteps: config.maxSteps,
        autoApprove: config.autoApprove,
      });
    }

    const preamble = includeContext ? await this.buildContextPreamble() : '';
    this.abortController = new AbortController();
    this.post({ type: 'busy', value: true });

    try {
      await this.agent.run(
        preamble + text,
        {
          onAssistantText: (delta) => this.post({ type: 'assistantDelta', text: delta }),
          onToolCall: (call, mutating) =>
            this.post({
              type: 'toolCall',
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
              mutating,
            }),
          onToolResult: (callId, result) => this.post({ type: 'toolResult', id: callId, result }),
          requestApproval: (call) => this.requestApproval(call, root),
          onNotice: (notice) => this.post({ type: 'notice', text: notice }),
        },
        this.abortController.signal
      );
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        this.post({ type: 'notice', text: 'Cancelled.' });
      } else {
        this.post({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.abortController = undefined;
      this.post({ type: 'busy', value: false });
    }
  }

  private async requestApproval(call: ToolCall, root: vscode.Uri): Promise<boolean> {
    let diff: string | undefined;
    let command: string | undefined;
    try {
      const args = parseToolArguments(call.function.arguments);
      if (call.function.name === 'write_file') {
        const filePath = typeof args['path'] === 'string' ? args['path'] : '';
        const newContent = typeof args['content'] === 'string' ? args['content'] : '';
        const host = new VsCodeWorkspaceHost(root);
        const oldContent = await host.readFile(filePath).catch(() => '');
        diff = createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'current', 'proposed');
      } else if (call.function.name === 'run_command') {
        command = typeof args['command'] === 'string' ? args['command'] : call.function.arguments;
      }
    } catch {
      // Malformed args: still show the approval card with raw arguments.
    }

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(call.id, (approved) => {
        this.post({ type: 'approvalResolved', id: call.id, approved });
        resolve(approved);
      });
      this.post({
        type: 'approvalRequest',
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
        ...(diff !== undefined ? { diff } : {}),
        ...(command !== undefined ? { command } : {}),
      });
    });
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
