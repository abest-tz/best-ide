import * as vscode from 'vscode';
import { ChatViewProvider } from './panel';
import { InlineCompletionProvider } from './tabCompletion';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context, context.extensionUri);
  const inlineCompletionProvider = new InlineCompletionProvider();

  context.subscriptions.push(
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
    vscode.commands.registerCommand('bestIde.showTelemetrySummary', () => provider.showTelemetrySummary()),
    vscode.commands.registerCommand('bestIde.resetTelemetry', () => provider.resetTelemetry()),
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
