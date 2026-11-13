import { Component, render } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { parseHostMessage, type CompletionItem, type WebviewToHost } from '../protocol';
import { parseInline } from './markdown';
import { FileChip, Inlines, Markdown } from './richText';
import { formatDuration, toolLabel } from './tools';
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

function StatusIcon({ status }: { status: 'running' | 'ok' | 'error' | 'stopped' }) {
  const label = { running: 'Running', ok: 'Done', error: 'Failed', stopped: 'Stopped' }[status];
  if (status === 'running')
    return <span class="spinner" role="img" aria-label={label} title={label} />;
  return (
    <svg
      class={`status-icon status-${status}`}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      {status === 'ok' && (
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.7" />
      )}
      {status === 'error' && (
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" />
      )}
      {status === 'stopped' && <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />}
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      class={`chevron${open ? ' open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" />
    </svg>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(item);
  const detailId = `tool-detail-${item.id}`;
  return (
    <div class={`tool tool-${item.status}`}>
      <button
        type="button"
        class="tool-row"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${label}. ${open ? 'Hide' : 'Show'} details`}
        onClick={() => setOpen(!open)}
      >
        <StatusIcon status={item.status} />
        <span class="tool-label" title={label}>
          {label}
        </span>
        <span class="tool-meta">
          {item.durationMs !== undefined ? formatDuration(item.durationMs) : ''}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div class="tool-detail" id={detailId}>
          <div class="tool-detail-title">{item.name}</div>
          {item.args && <pre>{item.args}</pre>}
          {item.result !== undefined && (
            <>
              <div class="tool-detail-title">
                Result{item.resultChars !== undefined ? ` (${formatChars(item.resultChars)})` : ''}
              </div>
              <pre>{item.result || '(empty)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PlanCard({ item }: { item: Extract<TimelineItem, { kind: 'plan' }> }) {
  const [open, setOpen] = useState(true);
  return (
    <section class="card plan" aria-label="Plan">
      <button type="button" class="card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span class="card-title">Plan</span>
        <span class="card-sub">
          {item.steps.length} step{item.steps.length === 1 ? '' : 's'} · {item.files.length} file
          {item.files.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div class="card-body">
          <ol class="plan-steps">
            {item.steps.map((s) => (
              <li>
                <Inlines nodes={parseInline(s)} send={send} />
              </li>
            ))}
          </ol>
          <div class="card-subtitle">Files chosen</div>
          <ul class="plan-files">
            {item.files.map((f) => (
              <li>
                <FileChip path={f.path} send={send} /> <span class="reason">{f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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

/** One timeline entry. Unchanged entries keep their object, so only the streaming one re-renders. */
class ItemView extends Component<{ item: TimelineItem }> {
  override shouldComponentUpdate(next: { item: TimelineItem }): boolean {
    return next.item !== this.props.item;
  }

  override render() {
    return <Item item={this.props.item} />;
  }
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
          <div class="msg assistant">
            <Markdown text={item.text} send={send} />
          </div>
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
          <ItemView key={item.id} item={item} />
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
