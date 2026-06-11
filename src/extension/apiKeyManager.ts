import * as vscode from 'vscode';

const API_KEY_SECRET_KEY = 'bestIde.apiKey';
const API_KEY_SETTING_KEY = 'apiKey';

function normalizeApiKey(value: string): string {
  return value.trim();
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

export class ApiKeyManager implements vscode.Disposable {
  private cachedApiKey: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      this.context.secrets.onDidChange((event) => {
        if (event.key === API_KEY_SECRET_KEY) {
          this.cachedApiKey = undefined;
        }
      })
    );
  }

  async initialize(): Promise<void> {
    await this.migrateLegacySetting();
    this.cachedApiKey = (await this.context.secrets.get(API_KEY_SECRET_KEY)) ?? '';
  }

  async getApiKey(): Promise<string> {
    if (this.cachedApiKey !== undefined) {
      return this.cachedApiKey;
    }
    this.cachedApiKey = (await this.context.secrets.get(API_KEY_SECRET_KEY)) ?? '';
    return this.cachedApiKey;
  }

  async setApiKey(value: string): Promise<void> {
    const normalized = normalizeApiKey(value);
    if (normalized === '') {
      await this.context.secrets.delete(API_KEY_SECRET_KEY);
      this.cachedApiKey = '';
    } else {
      await this.context.secrets.store(API_KEY_SECRET_KEY, normalized);
      this.cachedApiKey = normalized;
    }
    await this.clearLegacySetting();
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(API_KEY_SECRET_KEY);
    this.cachedApiKey = '';
    await this.clearLegacySetting();
  }

  async migrateLegacySetting(): Promise<void> {
    const config = vscode.workspace.getConfiguration('bestIde');
    const inspect = config.inspect<string>(API_KEY_SETTING_KEY);
    if (!inspect) {
      return;
    }

    const legacyApiKey = firstNonEmpty([
      inspect.workspaceFolderValue,
      inspect.workspaceValue,
      inspect.globalValue,
    ]);
    if (!legacyApiKey) {
      return;
    }

    await this.context.secrets.store(API_KEY_SECRET_KEY, legacyApiKey);
    this.cachedApiKey = legacyApiKey;
    await this.clearLegacySetting();
  }

  private async clearLegacySetting(): Promise<void> {
    const config = vscode.workspace.getConfiguration('bestIde');
    const inspect = config.inspect<string>(API_KEY_SETTING_KEY);
    if (!inspect) {
      return;
    }
    const updates: Array<Thenable<void>> = [];
    if (inspect.globalValue !== undefined) {
      updates.push(config.update(API_KEY_SETTING_KEY, undefined, vscode.ConfigurationTarget.Global));
    }
    if (inspect.workspaceValue !== undefined) {
      updates.push(config.update(API_KEY_SETTING_KEY, undefined, vscode.ConfigurationTarget.Workspace));
    }
    if (inspect.workspaceFolderValue !== undefined) {
      updates.push(config.update(API_KEY_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder));
    }
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
