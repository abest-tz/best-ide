import * as vscode from 'vscode';
import { ChatViewProvider } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('bestIde.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('bestIde.pickModel', () => provider.pickModelViaQuickPick())
  );
}

export function deactivate(): void {}
