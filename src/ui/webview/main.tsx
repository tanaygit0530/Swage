import { render } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { parseHostMessage, type CompletionItem, type WebviewToHost } from '../protocol';
import {
  applyCompletion,
  initialState,
  isBusy,
  mentionQuery,
  reduce,
  type PanelState,
  type TimelineItem,
} from './state';
import { Logo } from './logo';

/**
 * The Swage agent panel (blueprint sections 3 and 4): a Preact webview bundled into
 * dist/webview.js. It only exchanges validated messages with the extension host.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewToHost): void => vscode.postMessage(msg);

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const icon = { running: '◌', ok: '✓', error: '✗', stopped: '■' }[item.status];
  return (
    <div class={`tool tool-${item.status}`}>
      <span class="tool-icon" aria-hidden="true">
        {icon}
      </span>
      <span class="tool-name">{item.name}</span>
      <span class="tool-summary" title={item.summary}>
        {item.summary}
      </span>
      <span class="tool-meta">
        {item.durationMs !== undefined
          ? `${item.durationMs} ms`
          : item.status === 'running'
            ? 'running…'
            : ''}
        {item.resultChars !== undefined ? ` · ${formatChars(item.resultChars)}` : ''}
      </span>
    </div>
  );
}

function PlanCard({ item }: { item: Extract<TimelineItem, { kind: 'plan' }> }) {
  return (
    <div class="card plan">
      <div class="card-title">Plan</div>
      <ol>
        {item.steps.map((s) => (
          <li>{s}</li>
        ))}
      </ol>
      <div class="card-title">Files chosen</div>
      <ul class="files">
        {item.files.map((f) => (
          <li>
            <code>{f.path}</code> <span class="reason">{f.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalCard({ item }: { item: Extract<TimelineItem, { kind: 'approval' }> }) {
  const label =
    item.name === 'submit_change_set' ? 'Review the submitted change set' : `Run ${item.name}?`;
  return (
    <div class={`card approval approval-${item.decision}`}>
      <div class="card-title">{label}</div>
      <pre class="approval-summary">{item.summary}</pre>
      {item.decision === 'pending' ? (
        <div class="actions">
          <button onClick={() => send({ type: 'approve', toolCallId: item.id, allow: true })}>
            Approve
          </button>
          <button
            class="secondary"
            onClick={() =>
              send({
                type: 'approve',
                toolCallId: item.id,
                allow: false,
                reason: 'Denied by the user',
              })
            }
          >
            Deny
          </button>
        </div>
      ) : (
        <div class="decision">{item.decision === 'allowed' ? 'Approved' : 'Denied'}</div>
      )}
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'user':
      return <div class="msg user">{item.text}</div>;
    case 'assistant':
      return (
        <div class="turn">
          <span class="avatar" title="Swage">
            <Logo size={20} />
          </span>
          <div class="msg assistant">{item.text}</div>
        </div>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} />;
    case 'notice':
      return <div class={`notice notice-${item.tone}`}>{item.text}</div>;
  }
}

const MORE_MODELS = '__more__';

/** The model picker in the panel header: switch profile for the next request, or add another. */
function ModelPicker({ models, busy }: { models: PanelState['models']; busy: boolean }) {
  return (
    <select
      class="model-picker"
      aria-label="Model for the next request"
      title="Model for the next request (Swage: Switch Model)"
      value={models.active}
      disabled={busy}
      onChange={(e) => {
        const select = e.currentTarget;
        const value = select.value;
        if (value === MORE_MODELS) {
          select.value = models.active;
          send({ type: 'moreModels' });
        } else send({ type: 'selectModel', name: value });
      }}
    >
      {models.items.map((m) => (
        <option key={m.name} value={m.name}>
          {m.label} · {m.model}
          {m.note ? ` (${m.note})` : ''}
        </option>
      ))}
      <option value={MORE_MODELS}>Other models…</option>
    </select>
  );
}

function BudgetMeter({
  used,
  total,
  parts,
}: {
  used: number;
  total: number;
  parts: { label: string; tokens: number }[];
}) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div class="budget" title={parts.map((p) => `${p.label}: ${p.tokens} tokens`).join('\n')}>
      <div class="budget-label">
        Context {used.toLocaleString()} / {total.toLocaleString()} tokens
      </div>
      <div
        class="budget-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div class={`budget-fill${pct > 90 ? ' over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const [showCompletions, setShowCompletions] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const msg = parseHostMessage(e.data);
      if (msg) dispatch(msg);
    };
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [state.timeline]);

  const busy = isBusy(state.status);
  const items: CompletionItem[] = showCompletions ? state.completions.items : [];

  const onInput = (value: string, cursor: number): void => {
    setText(value);
    const q = mentionQuery(value, cursor);
    if (q) {
      requestId.current++;
      send({ type: 'complete', requestId: requestId.current, query: q.query });
      setShowCompletions(true);
      setSelected(0);
    } else {
      setShowCompletions(false);
    }
  };

  const choose = (item: CompletionItem): void => {
    const el = input.current;
    const cursor = el?.selectionStart ?? text.length;
    const next = applyCompletion(text, cursor, item.insertText);
    setText(next.text);
    setShowCompletions(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const submit = (): void => {
    if (busy || text.trim() === '') return;
    send({ type: 'submit', text: text.trim() });
    setText('');
    setShowCompletions(false);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (items.length > 0) {
      if (e.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % items.length);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const item = items[selected];
        if (item) choose(item);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        setShowCompletions(false);
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Escape' && busy) {
      send({ type: 'stop' });
      e.preventDefault();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      submit();
      e.preventDefault();
    }
  };

  const canRetry =
    state.status === 'cancelled' || state.status === 'error' || state.status === 'done';
  return (
    <div class="panel">
      <header>
        <div class="title">
          Swage agent{' '}
          {state.models.items.length > 0 ? (
            <ModelPicker models={state.models} busy={busy} />
          ) : (
            <span class="model">{state.model}</span>
          )}
        </div>
        {state.budget && <BudgetMeter {...state.budget} />}
      </header>
      <main class="timeline" aria-live="polite">
        {state.timeline.length === 0 && (
          <div class="empty">
            <Logo size={64} title="Swage" />
            <div class="empty-name">Swage</div>
            <div class="empty-hint">
              Describe a change. Mention files with @path or symbols with @name; Swage finds the
              rest.
            </div>
          </div>
        )}
        {state.timeline.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div ref={bottom} />
      </main>
      <footer>
        <div class="status">
          <span class={`dot dot-${state.status}`} aria-hidden="true" />
          {state.statusMessage || state.status}
        </div>
        {items.length > 0 && (
          <ul class="completions" role="listbox">
            {items.map((c, i) => (
              <li
                role="option"
                aria-selected={i === selected}
                class={i === selected ? 'selected' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
              >
                <span class="kind">{c.kind === 'file' ? 'file' : 'sym'}</span> {c.label}{' '}
                <span class="detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={input}
          rows={3}
          value={text}
          placeholder={
            busy
              ? 'Running… press Stop or Escape to cancel'
              : 'Ask Swage to change the code (Enter to send, Shift+Enter for a new line)'
          }
          disabled={busy}
          onInput={(e) => {
            const el = e.currentTarget;
            onInput(el.value, el.selectionStart);
          }}
          onKeyDown={onKeyDown}
        />
        <div class="buttons">
          {busy ? (
            <button
              class="stop"
              onClick={() => send({ type: 'stop' })}
              disabled={state.status === 'cancelling'}
            >
              Stop
            </button>
          ) : (
            <button onClick={submit} disabled={text.trim() === ''}>
              Send
            </button>
          )}
          {canRetry && (
            <button class="secondary" onClick={() => send({ type: 'retry' })}>
              Retry
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
