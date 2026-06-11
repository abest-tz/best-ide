import * as vscode from 'vscode';
import { VsCodeWorkspaceHost } from './host';
import { createMentionSuggestionSource } from './mentionSuggestionSource';
import { resolveMentionSuggestions } from './mentionSuggestions';

function toCompletionItemKind(kind: 'kind' | 'file' | 'folder' | 'symbol' | 'skill'): vscode.CompletionItemKind {
  if (kind === 'file') {
    return vscode.CompletionItemKind.File;
  }
  if (kind === 'folder') {
    return vscode.CompletionItemKind.Folder;
  }
  if (kind === 'symbol') {
    return vscode.CompletionItemKind.Reference;
  }
  if (kind === 'skill') {
    return vscode.CompletionItemKind.Reference;
  }
  return vscode.CompletionItemKind.Keyword;
}

export class MentionCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (document.uri.scheme !== 'file') {
      return undefined;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const lineText = document.lineAt(position.line).text;
    const source = createMentionSuggestionSource(
      new VsCodeWorkspaceHost(workspaceFolder.uri, {
        workspaceFolders: vscode.workspace.workspaceFolders ?? [],
      })
    );
    const result = await resolveMentionSuggestions(
      {
        text: lineText,
        cursor: position.character,
      },
      source
    );
    if (!result.active || result.items.length === 0) {
      return undefined;
    }

    const range = new vscode.Range(position.line, result.rangeStart, position.line, result.rangeEnd);
    return result.items.map((suggestion, index) => {
      const item = new vscode.CompletionItem(suggestion.label, toCompletionItemKind(suggestion.kind));
      item.insertText = suggestion.insertText;
      item.range = range;
      item.filterText = suggestion.insertText;
      item.sortText = index.toString().padStart(4, '0');
      if (suggestion.detail) {
        item.detail = suggestion.detail;
      }
      return item;
    });
  }
}
