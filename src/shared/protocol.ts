/** Messages exchanged between the extension host and the webview. */

export interface ModelOption {
  id: string;
}

export type ToExtensionMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; includeContext: boolean }
  | { type: 'approvalResponse'; id: string; approved: boolean }
  | { type: 'pickModel'; model: string }
  | { type: 'refreshModels' }
  | { type: 'newChat' }
  | { type: 'cancel' };

export type ToWebviewMessage =
  | {
      type: 'init';
      models: ModelOption[];
      model: string;
      connected: boolean;
      error?: string;
    }
  | { type: 'modelsUpdated'; models: ModelOption[]; model: string; connected: boolean; error?: string }
  | { type: 'busy'; value: boolean }
  | { type: 'assistantDelta'; text: string }
  | { type: 'toolCall'; id: string; name: string; args: string; mutating: boolean }
  | { type: 'toolResult'; id: string; result: string }
  | {
      type: 'approvalRequest';
      id: string;
      name: string;
      args: string;
      /** Unified diff for write_file calls. */
      diff?: string;
      /** Command preview for run_command calls. */
      command?: string;
    }
  | { type: 'approvalResolved'; id: string; approved: boolean }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'cleared' };
