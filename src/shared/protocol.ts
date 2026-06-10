/** Messages exchanged between the extension host and the webview. */

export interface ModelOption {
  id: string;
}

export type ChatMode = 'agent' | 'ask' | 'composer';

export interface PersistedTranscriptItem {
  kind: 'user' | 'assistant' | 'notice' | 'error';
  text: string;
}

export type ToExtensionMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'approvalResponse'; id: string; approved: boolean }
  | { type: 'stepLimitResponse'; id: string; continueRun: boolean }
  | { type: 'pendingChangeDecision'; id: string; accepted: boolean }
  | { type: 'acceptAllPendingChanges' }
  | { type: 'revertLastTurn' }
  | { type: 'pickModel'; model: string }
  | { type: 'refreshModels' }
  | { type: 'newChat' }
  | { type: 'setMode'; mode: ChatMode }
  | { type: 'cancel' };

export type ToWebviewMessage =
  | {
      type: 'init';
      models: ModelOption[];
      model: string;
      mode: ChatMode;
      connected: boolean;
      error?: string;
    }
  | {
      type: 'modelsUpdated';
      models: ModelOption[];
      model: string;
      mode: ChatMode;
      connected: boolean;
      error?: string;
    }
  | { type: 'modeChanged'; mode: ChatMode }
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
  | { type: 'stepLimitRequest'; id: string; stepLimit: number; completedSteps: number }
  | { type: 'stepLimitResolved'; id: string; continued: boolean }
  | { type: 'pendingChange'; id: string; path: string; turnId: number }
  | { type: 'pendingChangeResolved'; id: string; accepted: boolean }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'threadLoaded'; id: string; title: string; transcript: PersistedTranscriptItem[] }
  | { type: 'focusComposer' }
  | { type: 'cleared' };
