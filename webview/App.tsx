import { marked } from 'marked';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelOption, ToWebviewMessage } from '../src/shared/protocol';
import { postToExtension } from './vscodeApi';

type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; closed: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; mutating: boolean; result?: string }
  | {
      kind: 'approval';
      id: string;
      name: string;
      args: string;
      diff?: string;
      command?: string;
      resolved: boolean;
      approved?: boolean;
    }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

marked.setOptions({ gfm: true, breaks: true });

function Markdown({ text }: { text: string }): React.JSX.Element {
  // CSP blocks inline scripts (nonce-only), so rendered HTML cannot execute code.
  return <div dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />;
}

function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n').filter((line) => !line.startsWith('\\ No newline'));
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }): React.JSX.Element {
  return (
    <details className="tool-card">
      <summary>
        <span className="tool-name">{item.name}</span>
        <span className="tool-status">{item.result === undefined ? 'running...' : 'done'}</span>
      </summary>
      <div className="tool-body">
        <pre>{item.args || '{}'}</pre>
        {item.result !== undefined && <pre>{item.result}</pre>}
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
  return (
    <div className="approval-card">
      <div className="approval-title">
        {item.name === 'write_file' ? 'Write file' : item.name === 'run_command' ? 'Run command' : item.name}
      </div>
      <div className="approval-body">
        {item.diff !== undefined ? (
          <DiffView diff={item.diff} />
        ) : item.command !== undefined ? (
          <pre className="command">$ {item.command}</pre>
        ) : (
          <pre className="command">{item.args}</pre>
        )}
      </div>
      {item.resolved ? (
        <div className="approval-resolved">{item.approved ? 'Approved' : 'Rejected'}</div>
      ) : (
        <div className="approval-actions">
          <button className="button primary" onClick={() => respond(true)}>
            Approve
          </button>
          <button className="button secondary" onClick={() => respond(false)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const handleMessage = useCallback((message: ToWebviewMessage): void => {
    switch (message.type) {
      case 'init':
      case 'modelsUpdated':
        setModels(message.models);
        setModel(message.model);
        setConnected(message.connected);
        setConnectionError(message.error);
        break;
      case 'busy':
        setBusy(message.value);
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
      case 'approvalRequest':
        setTranscript((t) => [
          ...t,
          {
            kind: 'approval',
            id: message.id,
            name: message.name,
            args: message.args,
            diff: message.diff,
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
      case 'notice':
        setTranscript((t) => [...t, { kind: 'notice', text: message.text }]);
        break;
      case 'error':
        setTranscript((t) => [...t, { kind: 'error', text: message.message }]);
        break;
      case 'cleared':
        setTranscript([]);
        setBusy(false);
        break;
    }
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent): void => handleMessage(event.data as ToWebviewMessage);
    window.addEventListener('message', listener);
    postToExtension({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [handleMessage]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [transcript]);

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    setTranscript((t) => [...t, { kind: 'user', text }]);
    setInput('');
    postToExtension({ type: 'send', text, includeContext });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const hasPendingApproval = transcript.some((item) => item.kind === 'approval' && !item.resolved);

  return (
    <div className="app">
      <div className="header">
        <span
          className={`status-dot ${connected ? 'connected' : 'disconnected'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
        <select
          value={model}
          disabled={!connected || models.length === 0}
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
        <button
          className="icon-button"
          title="Refresh models"
          onClick={() => postToExtension({ type: 'refreshModels' })}
        >
          &#x21bb;
        </button>
      </div>

      {connectionError && <div className="error-banner">{connectionError}</div>}

      <div className="transcript" ref={transcriptRef}>
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
                  <div key={index} className="message user">
                    {item.text}
                  </div>
                );
              case 'assistant':
                return (
                  <div key={index} className="message assistant">
                    <Markdown text={item.text} />
                  </div>
                );
              case 'tool':
                return <ToolCard key={item.id + index} item={item} />;
              case 'approval':
                return <ApprovalCard key={item.id + index} item={item} />;
              case 'notice':
                return (
                  <div key={index} className="message notice">
                    {item.text}
                  </div>
                );
              case 'error':
                return (
                  <div key={index} className="message error">
                    {item.text}
                  </div>
                );
            }
          })
        )}
        {busy && !hasPendingApproval && <div className="thinking">working...</div>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask the agent anything... (Enter to send)"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <label>
            <input
              type="checkbox"
              checked={includeContext}
              onChange={(event) => setIncludeContext(event.target.checked)}
            />
            Include active file
          </label>
          <span className="spacer" />
          {busy ? (
            <button className="button secondary" onClick={() => postToExtension({ type: 'cancel' })}>
              Stop
            </button>
          ) : (
            <button className="button primary" disabled={!input.trim() || !connected} onClick={send}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
