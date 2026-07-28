import { marked } from 'marked';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMode,
  MentionSuggestionItem,
  ModelOption,
  PersistedTranscriptItem,
  ToWebviewMessage,
} from '../src/shared/protocol';
import { postToExtension } from './vscodeApi';

type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; closed: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args: string;
      mutating: boolean;
      command?: string;
      result?: string;
    }
  | {
      kind: 'approval';
      id: string;
      name: string;
      args: string;
      command?: string;
      resolved: boolean;
      approved?: boolean;
    }
  | {
      kind: 'stepLimit';
      id: string;
      stepLimit: number;
      completedSteps: number;
      resolved: boolean;
      continued?: boolean;
    }
  | {
      kind: 'pendingChange';
      id: string;
      path: string;
      turnId: number;
      resolved: boolean;
      accepted?: boolean;
    }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

interface MentionSuggestionState {
  active: boolean;
  requestId: string;
  rangeStart: number;
  rangeEnd: number;
  items: MentionSuggestionItem[];
  selectedIndex: number;
}

const EMPTY_MENTION_SUGGESTIONS: MentionSuggestionState = {
  active: false,
  requestId: '',
  rangeStart: 0,
  rangeEnd: 0,
  items: [],
  selectedIndex: 0,
};

marked.setOptions({ gfm: true, breaks: true });

interface ParsedRunCommandResult {
  exitCode?: string;
  stdout: string;
  stderr: string;
}

function parseRunCommandResult(result: string | undefined): ParsedRunCommandResult | undefined {
  if (result === undefined) {
    return undefined;
  }
  const exitMatch = /^exit code:\s*(-?\d+)/i.exec(result);
  if (!exitMatch) {
    return undefined;
  }
  const stdoutMarker = '\nstdout:\n';
  const stderrMarker = '\nstderr:\n';
  const stdoutStart = result.indexOf(stdoutMarker);
  if (stdoutStart === -1) {
    return undefined;
  }
  const stderrStart = result.indexOf(stderrMarker, stdoutStart + stdoutMarker.length);
  if (stderrStart === -1) {
    return undefined;
  }
  return {
    exitCode: exitMatch[1],
    stdout: result.slice(stdoutStart + stdoutMarker.length, stderrStart).trim(),
    stderr: result.slice(stderrStart + stderrMarker.length).trim(),
  };
}

function parseRunCommandFromArgs(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return typeof parsed.command === 'string' ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  // CSP blocks inline scripts (nonce-only), so rendered HTML cannot execute code.
  return <div dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />;
}

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }): React.JSX.Element {
  const isRunCommand = item.name === 'run_command';
  const command = item.command ?? parseRunCommandFromArgs(item.args);
  const parsedRunCommandResult = isRunCommand ? parseRunCommandResult(item.result) : undefined;

  return (
    <details className="tool-card" aria-label={`Tool call ${item.name}`}>
      <summary>
        <span className="tool-name">{item.name}</span>
        <span className="tool-status" aria-live="polite">
          {item.result === undefined ? 'running...' : 'done'}
        </span>
      </summary>
      <div className="tool-body">
        {isRunCommand ? (
          <>
            <div className="tool-section-label">Command</div>
            <pre className="command">{command ? `$ ${command}` : item.args || '{}'}</pre>
            {item.result !== undefined && (
              <>
                <div className="tool-section-label">Result</div>
                {parsedRunCommandResult ? (
                  <>
                    <pre className="command">exit code: {parsedRunCommandResult.exitCode ?? '?'}</pre>
                    <div className="tool-section-label">stdout</div>
                    <pre>{parsedRunCommandResult.stdout || '(empty)'}</pre>
                    <div className="tool-section-label">stderr</div>
                    <pre>{parsedRunCommandResult.stderr || '(empty)'}</pre>
                  </>
                ) : (
                  <pre>{item.result}</pre>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <pre>{item.args || '{}'}</pre>
            {item.result !== undefined && <pre>{item.result}</pre>}
          </>
        )}
      </div>
    </details>
  );
}

function ApprovalCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'approval' }>;
}): React.JSX.Element {
  const respond = (approved: boolean): void => {
    postToExtension({ type: 'approvalResponse', id: item.id, approved });
  };
  const title =
    item.name === 'run_command'
      ? 'Run command'
      : item.name === 'mcp_call_tool'
        ? 'MCP tool call'
        : item.name;
  return (
    <div className="approval-card" role="group" aria-label="Approval request">
      <div className="approval-title">{title}</div>
      <div className="approval-body">
        {item.command !== undefined ? (
          <pre className="command">$ {item.command}</pre>
        ) : (
          <pre className="command">{item.args}</pre>
        )}
      </div>
      {item.resolved ? (
        <div className="approval-resolved" role="status">
          {item.approved ? 'Approved' : 'Rejected'}
        </div>
      ) : (
        <div className="approval-actions">
          <button className="button primary" aria-label="Approve request" onClick={() => respond(true)}>
            Approve
          </button>
          <button className="button secondary" aria-label="Reject request" onClick={() => respond(false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function StepLimitCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'stepLimit' }>;
}): React.JSX.Element {
  const respond = (continueRun: boolean): void => {
    postToExtension({ type: 'stepLimitResponse', id: item.id, continueRun });
  };
  return (
    <div className="approval-card" role="group" aria-label="Step limit decision">
      <div className="approval-title">Step limit reached</div>
      <div className="approval-body">
        <pre className="command">
          Reached {item.completedSteps} model turns (limit {item.stepLimit}). Continue for another{' '}
          {item.stepLimit} turns?
        </pre>
      </div>
      {item.resolved ? (
        <div className="approval-resolved" role="status">
          {item.continued ? 'Continuing' : 'Stopped'}
        </div>
      ) : (
        <div className="approval-actions">
          <button className="button primary" aria-label="Continue run" onClick={() => respond(true)}>
            Continue
          </button>
          <button className="button secondary" aria-label="Stop run" onClick={() => respond(false)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

function PendingChangeCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'pendingChange' }>;
}): React.JSX.Element {
  const respond = (accepted: boolean): void => {
    postToExtension({ type: 'pendingChangeDecision', id: item.id, accepted });
  };
  const review = (): void => {
    postToExtension({ type: 'reviewPendingChange', id: item.id });
  };

  return (
    <div className="approval-card" role="group" aria-label={`Pending change ${item.path}`}>
      <div className="approval-title">Pending file change</div>
      <div className="approval-body">
        <pre className="command">{item.path}</pre>
      </div>
      {item.resolved ? (
        <div className="approval-resolved" role="status">
          {item.accepted ? 'Accepted' : 'Rejected'}
        </div>
      ) : (
        <div className="approval-actions">
          <button className="button secondary" aria-label={`Review change for ${item.path}`} onClick={review}>
            Review
          </button>
          <button className="button primary" aria-label={`Accept change for ${item.path}`} onClick={() => respond(true)}>
            Accept
          </button>
          <button className="button secondary" aria-label={`Reject change for ${item.path}`} onClick={() => respond(false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function restoreTranscript(items: PersistedTranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === 'assistant') {
      return { kind: 'assistant', text: item.text, closed: true };
    }
    if (item.kind === 'user') {
      return { kind: 'user', text: item.text };
    }
    if (item.kind === 'notice') {
      return { kind: 'notice', text: item.text };
    }
    return { kind: 'error', text: item.text };
  });
}

export function App(): React.JSX.Element {
  const transcriptId = 'chat-transcript';
  const composerId = 'chat-composer';
  const composerHintId = 'chat-composer-hint';
  const threadMetaId = 'chat-thread-meta';
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [threadTitle, setThreadTitle] = useState('New chat');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [mentionSuggestions, setMentionSuggestions] =
    useState<MentionSuggestionState>(EMPTY_MENTION_SUGGESTIONS);
  const [liveRegionText, setLiveRegionText] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mentionRequestCounterRef = useRef(0);
  const latestMentionRequestIdRef = useRef('');
  const mentionDebounceTimerRef = useRef<number | undefined>(undefined);

  const focusComposer = useCallback((): void => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.focus();
    const end = composer.value.length;
    composer.setSelectionRange(end, end);
  }, []);

  const focusTranscript = useCallback((): void => {
    transcriptRef.current?.focus();
  }, []);

  const dismissMentionSuggestions = useCallback((): void => {
    setMentionSuggestions(EMPTY_MENTION_SUGGESTIONS);
  }, []);

  const updateCursorFromComposer = useCallback((): void => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    setCursorOffset(composer.selectionStart ?? composer.value.length);
  }, []);

  const acceptMentionSuggestion = useCallback(
    (index: number): void => {
      if (!mentionSuggestions.active || mentionSuggestions.items.length === 0) {
        return;
      }
      const suggestion = mentionSuggestions.items[index];
      if (!suggestion) {
        return;
      }

      const start = Math.max(0, Math.min(mentionSuggestions.rangeStart, input.length));
      const end = Math.max(start, Math.min(mentionSuggestions.rangeEnd, input.length));
      const nextInput = `${input.slice(0, start)}${suggestion.insertText}${input.slice(end)}`;
      const nextCursor = start + suggestion.insertText.length;

      setInput(nextInput);
      setCursorOffset(nextCursor);
      setMentionSuggestions(EMPTY_MENTION_SUGGESTIONS);
      window.requestAnimationFrame(() => {
        const composer = composerRef.current;
        if (!composer) {
          return;
        }
        composer.focus();
        composer.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [input, mentionSuggestions]
  );

  const handleMessage = useCallback((message: ToWebviewMessage): void => {
    switch (message.type) {
      case 'init':
      case 'modelsUpdated':
        setModels(message.models);
        setModel(message.model);
        setMode(message.mode);
        setConnected(message.connected);
        setConnectionError(message.error);
        setLiveRegionText(message.connected ? 'Connected to model backend.' : 'Disconnected from model backend.');
        break;
      case 'modeChanged':
        setMode(message.mode);
        setLiveRegionText(`Switched to ${message.mode} mode.`);
        break;
      case 'busy':
        setBusy(message.value);
        setLiveRegionText(message.value ? 'Assistant is working.' : 'Assistant is ready.');
        if (!message.value) {
          setTranscript((t) =>
            t.map((item) => (item.kind === 'assistant' ? { ...item, closed: true } : item))
          );
        }
        break;
      case 'assistantDelta':
        setTranscript((t) => {
          const last = t[t.length - 1];
          if (last?.kind === 'assistant' && !last.closed) {
            return [...t.slice(0, -1), { ...last, text: last.text + message.text }];
          }
          return [...t, { kind: 'assistant', text: message.text, closed: false }];
        });
        break;
      case 'toolCall':
        setTranscript((t) => [
          ...t.map((item) => (item.kind === 'assistant' ? { ...item, closed: true } : item)),
          {
            kind: 'tool',
            id: message.id,
            name: message.name,
            args: message.args,
            mutating: message.mutating,
            command: message.command,
          },
        ]);
        break;
      case 'toolResult':
        setTranscript((t) =>
          t.map((item) =>
            item.kind === 'tool' && item.id === message.id ? { ...item, result: message.result } : item
          )
        );
        break;
      case 'mentionSuggestionsResult':
        if (message.requestId !== latestMentionRequestIdRef.current) {
          break;
        }
        if (!message.active || message.items.length === 0) {
          setMentionSuggestions(EMPTY_MENTION_SUGGESTIONS);
          break;
        }
        setMentionSuggestions({
          active: true,
          requestId: message.requestId,
          rangeStart: message.rangeStart,
          rangeEnd: message.rangeEnd,
          items: message.items,
          selectedIndex: 0,
        });
        break;
      case 'approvalRequest':
        setTranscript((t) => [
          ...t,
          {
            kind: 'approval',
            id: message.id,
            name: message.name,
            args: message.args,
            command: message.command,
            resolved: false,
          },
        ]);
        break;
      case 'approvalResolved':
        setTranscript((t) =>
          t.map((item) =>
            item.kind === 'approval' && item.id === message.id
              ? { ...item, resolved: true, approved: message.approved }
              : item
          )
        );
        break;
      case 'stepLimitRequest':
        setTranscript((t) => [
          ...t,
          {
            kind: 'stepLimit',
            id: message.id,
            stepLimit: message.stepLimit,
            completedSteps: message.completedSteps,
            resolved: false,
          },
        ]);
        break;
      case 'stepLimitResolved':
        setTranscript((t) =>
          t.map((item) =>
            item.kind === 'stepLimit' && item.id === message.id
              ? { ...item, resolved: true, continued: message.continued }
              : item
          )
        );
        break;
      case 'pendingChange':
        setTranscript((t) => {
          const existingIndex = t.findIndex(
            (item) => item.kind === 'pendingChange' && item.id === message.id && !item.resolved
          );
          if (existingIndex >= 0) {
            const next = [...t];
            next[existingIndex] = {
              kind: 'pendingChange',
              id: message.id,
              path: message.path,
              turnId: message.turnId,
              resolved: false,
            };
            return next;
          }
          return [
            ...t,
            {
              kind: 'pendingChange',
              id: message.id,
              path: message.path,
              turnId: message.turnId,
              resolved: false,
            },
          ];
        });
        break;
      case 'pendingChangeResolved':
        setTranscript((t) =>
          t.map((item) =>
            item.kind === 'pendingChange' && item.id === message.id
              ? { ...item, resolved: true, accepted: message.accepted }
              : item
          )
        );
        break;
      case 'notice':
        setLiveRegionText(message.text);
        setTranscript((t) => [...t, { kind: 'notice', text: message.text }]);
        break;
      case 'error':
        setLiveRegionText(message.message);
        setTranscript((t) => [...t, { kind: 'error', text: message.message }]);
        break;
      case 'threadLoaded':
        setThreadTitle(message.title);
        setTranscript(restoreTranscript(message.transcript));
        setBusy(false);
        setLiveRegionText(`Loaded conversation ${message.title}.`);
        break;
      case 'cleared':
        setThreadTitle('New chat');
        setTranscript([]);
        setBusy(false);
        setLiveRegionText('Started a new conversation.');
        break;
      case 'focusComposer':
        focusComposer();
        break;
    }
  }, [focusComposer]);

  useEffect(() => {
    const listener = (event: MessageEvent): void => handleMessage(event.data as ToWebviewMessage);
    window.addEventListener('message', listener);
    postToExtension({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [handleMessage]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [transcript]);

  useEffect(() => {
    if (mentionDebounceTimerRef.current !== undefined) {
      window.clearTimeout(mentionDebounceTimerRef.current);
    }
    const requestId = `mention-${++mentionRequestCounterRef.current}`;
    latestMentionRequestIdRef.current = requestId;
    mentionDebounceTimerRef.current = window.setTimeout(() => {
      postToExtension({
        type: 'mentionSuggestionsRequest',
        requestId,
        text: input,
        cursor: cursorOffset,
      });
    }, 150);
    return () => {
      if (mentionDebounceTimerRef.current !== undefined) {
        window.clearTimeout(mentionDebounceTimerRef.current);
        mentionDebounceTimerRef.current = undefined;
      }
    };
  }, [cursorOffset, input]);

  const send = (): void => {
    const text = input.trim();
    if (!text || busy || mentionMenuOpen) {
      return;
    }
    setTranscript((t) => [...t, { kind: 'user', text }]);
    setInput('');
    setCursorOffset(0);
    dismissMentionSuggestions();
    postToExtension({ type: 'send', text });
    window.requestAnimationFrame(() => focusComposer());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentionMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionSuggestions((state) => {
          if (!state.active || state.items.length === 0) {
            return state;
          }
          return {
            ...state,
            selectedIndex: (state.selectedIndex + 1) % state.items.length,
          };
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionSuggestions((state) => {
          if (!state.active || state.items.length === 0) {
            return state;
          }
          return {
            ...state,
            selectedIndex: (state.selectedIndex - 1 + state.items.length) % state.items.length,
          };
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        acceptMentionSuggestion(mentionSuggestions.selectedIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissMentionSuggestions();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const mentionMenuOpen = mentionSuggestions.active && mentionSuggestions.items.length > 0;
  const hasPendingApproval = transcript.some((item) => item.kind === 'approval' && !item.resolved);
  const hasPendingStepLimit = transcript.some((item) => item.kind === 'stepLimit' && !item.resolved);
  const hasPendingChanges = transcript.some(
    (item) => item.kind === 'pendingChange' && !item.resolved
  );
  const modeTitle =
    mode === 'ask'
      ? 'Ask mode: read-only tools (no edits or commands).'
      : mode === 'composer'
        ? 'Composer mode: structured plan + multi-file apply.'
        : 'Agent mode: full tool access.';

  return (
    <div className="app">
      <div className="skip-links" aria-label="Quick navigation">
        <button className="skip-link" type="button" onClick={focusTranscript}>
          Skip to transcript
        </button>
        <button className="skip-link" type="button" onClick={focusComposer}>
          Skip to composer
        </button>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveRegionText}
      </div>
      <div className="header" role="region" aria-label="Chat controls">
        <span className="connection-indicator" role="status" aria-live="polite">
          <span
            className={`status-dot ${connected ? 'connected' : 'disconnected'}`}
            title={connected ? 'Connected' : 'Disconnected'}
            aria-hidden="true"
          />
          <span className="sr-only">{connected ? 'Connected' : 'Disconnected'}</span>
        </span>
        <select
          className="model-select"
          value={model}
          disabled={!connected || models.length === 0}
          aria-label="Model"
          onChange={(event) => {
            setModel(event.target.value);
            postToExtension({ type: 'pickModel', model: event.target.value });
          }}
        >
          {models.length === 0 ? (
            <option value="">no models</option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))
          )}
        </select>
        <select
          className="mode-select"
          value={mode}
          disabled={busy}
          title={modeTitle}
          aria-label="Chat mode"
          onChange={(event) => {
            const nextMode: ChatMode =
              event.target.value === 'ask'
                ? 'ask'
                : event.target.value === 'composer'
                  ? 'composer'
                  : 'agent';
            postToExtension({ type: 'setMode', mode: nextMode });
          }}
        >
          <option value="agent">Agent</option>
          <option value="composer">Composer</option>
          <option value="ask">Ask</option>
        </select>
        <button
          className="icon-button"
          title="Refresh models"
          aria-label="Refresh models"
          onClick={() => postToExtension({ type: 'refreshModels' })}
        >
          &#x21bb;
        </button>
      </div>

      {connectionError && (
        <div className="error-banner" role="alert">
          {connectionError}
        </div>
      )}

      <div
        id={transcriptId}
        className="transcript"
        ref={transcriptRef}
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        tabIndex={0}
      >
        {transcript.length === 0 && !connectionError ? (
          <div className="empty-state">
            <div>
              <strong>Best IDE Agent</strong>
            </div>
            <div>
              Chat with a local model running in LM Studio. The agent can read, search, and edit your
              workspace, and run commands with your approval.
            </div>
          </div>
        ) : (
          transcript.map((item, index) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={index} className="message user" role="article" aria-label="You">
                    {item.text}
                  </div>
                );
              case 'assistant':
                return (
                  <div key={index} className="message assistant" role="article" aria-label="Assistant">
                    <Markdown text={item.text} />
                  </div>
                );
              case 'tool':
                return <ToolCard key={item.id + index} item={item} />;
              case 'approval':
                return <ApprovalCard key={item.id + index} item={item} />;
              case 'stepLimit':
                return <StepLimitCard key={item.id + index} item={item} />;
              case 'pendingChange':
                return <PendingChangeCard key={item.id + index} item={item} />;
              case 'notice':
                return (
                  <div key={index} className="message notice" role="status">
                    {item.text}
                  </div>
                );
              case 'error':
                return (
                  <div key={index} className="message error" role="alert">
                    {item.text}
                  </div>
                );
            }
          })
        )}
        {busy && !hasPendingApproval && !hasPendingStepLimit && (
          <div className="thinking" role="status" aria-live="polite">
            working...
          </div>
        )}
      </div>

      <div className="composer" role="region" aria-label="Message composer">
        <textarea
          id={composerId}
          ref={composerRef}
          value={input}
          placeholder={
            mode === 'ask'
              ? 'Ask about the codebase (read-only mode)... Use @file:path, @folder:path, @symbol:query, @skill:name'
              : mode === 'composer'
                ? 'Describe a multi-file task... Composer will plan + apply. Use @file:path, @folder:path, @symbol:query, @skill:name'
                : 'Ask the agent... Use @file:path, @folder:path, @symbol:query, @skill:name'
          }
          aria-label="Chat input"
          aria-describedby={`${composerHintId} ${threadMetaId}`}
          onChange={(event) => {
            setInput(event.target.value);
            setCursorOffset(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={updateCursorFromComposer}
          onClick={updateCursorFromComposer}
          onKeyUp={updateCursorFromComposer}
          onKeyDown={onKeyDown}
        />
        {mentionMenuOpen && (
          <div className="mention-suggestions" role="listbox" aria-label="Mention suggestions">
            {mentionSuggestions.items.map((item, index) => (
              <button
                key={`${item.kind}:${item.insertText}:${index}`}
                type="button"
                className={`mention-suggestion-item ${index === mentionSuggestions.selectedIndex ? 'active' : ''}`}
                role="option"
                aria-selected={index === mentionSuggestions.selectedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => acceptMentionSuggestion(index)}
              >
                <span className="mention-suggestion-label">{item.label}</span>
                {item.detail && <span className="mention-suggestion-detail">{item.detail}</span>}
              </button>
            ))}
          </div>
        )}
        <div id={composerHintId} className="sr-only">
          Press Enter to send. Press Shift+Enter for a new line.
        </div>
        <div className="composer-row">
          <span id={threadMetaId} title={threadTitle}>
            Thread: {threadTitle}
          </span>
          <span>
            {mode === 'ask'
              ? 'Ask mode: read-only tools only.'
              : mode === 'composer'
                ? 'Composer mode: structured plan + multi-file apply.'
              : 'Tip: add line ranges with @file:path:start-end and skills with @skill:name'}
          </span>
          {hasPendingChanges && (
            <>
              <button
                className="button secondary"
                aria-label="Accept all pending changes"
                onClick={() => postToExtension({ type: 'acceptAllPendingChanges' })}
              >
                Accept all
              </button>
              <button
                className="button secondary"
                aria-label="Revert last accepted turn"
                onClick={() => postToExtension({ type: 'revertLastTurn' })}
              >
                Revert last turn
              </button>
            </>
          )}
          <span className="spacer" />
          {busy ? (
            <button
              className="button secondary"
              aria-label="Stop current run"
              onClick={() => postToExtension({ type: 'cancel' })}
            >
              Stop
            </button>
          ) : (
            <button
              className="button primary"
              aria-label="Send message"
              disabled={!input.trim() || !connected || mentionMenuOpen}
              onClick={send}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
