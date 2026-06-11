import * as vscode from 'vscode';
import { ApiKeyManager } from './apiKeyManager';
import { ChatViewProvider } from './panel';
import { InlineCompletionProvider } from './tabCompletion';

export function activate(context: vscode.ExtensionContext): void {
  const apiKeyManager = new ApiKeyManager(context);
  void apiKeyManager.initialize();

  const provider = new ChatViewProvider(context, context.extensionUri, () => apiKeyManager.getApiKey());
  const inlineCompletionProvider = new InlineCompletionProvider(() => apiKeyManager.getApiKey());

  context.subscriptions.push(
    apiKeyManager,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('bestIde.apiKey')) {
        void apiKeyManager.migrateLegacySetting();
      }
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(ChatViewProvider.pendingScheme, provider),
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file' },
      inlineCompletionProvider
    ),
    vscode.commands.registerCommand('bestIde.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('bestIde.searchThreads', () => provider.searchThreads()),
    vscode.commands.registerCommand('bestIde.exportThread', () => provider.exportActiveThread()),
    vscode.commands.registerCommand('bestIde.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Enter API key for the default Best IDE backend',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      const trimmed = value.trim();
      await apiKeyManager.setApiKey(trimmed);
      void vscode.window.showInformationMessage(
        trimmed === '' ? 'Best IDE API key cleared.' : 'Best IDE API key saved to Secret Storage.'
      );
    }),
    vscode.commands.registerCommand('bestIde.clearApiKey', async () => {
      await apiKeyManager.clearApiKey();
      void vscode.window.showInformationMessage('Best IDE API key cleared from Secret Storage.');
    }),
    vscode.commands.registerCommand('bestIde.pickModel', () => provider.pickModelViaQuickPick()),
    vscode.commands.registerCommand('bestIde.focusChat', () => provider.focusChatComposer()),
    vscode.commands.registerTextEditorCommand('bestIde.inlineEdit', (editor) =>
      void provider.runInlineEdit(editor)
    ),
    vscode.commands.registerCommand('bestIde.acceptAgentChange', (uri?: vscode.Uri) =>
      provider.acceptAgentChange(uri)
    ),
    vscode.commands.registerCommand('bestIde.rejectAgentChange', (uri?: vscode.Uri) =>
      provider.rejectAgentChange(uri)
    ),
    vscode.commands.registerCommand('bestIde.acceptAllAgentChanges', () => provider.acceptAllAgentChanges()),
    vscode.commands.registerCommand('bestIde.revertLastAgentTurn', () => provider.revertLastAgentTurn())
  );
}

export function deactivate(): void {}
