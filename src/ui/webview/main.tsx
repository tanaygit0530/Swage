import { Component, render } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { parseHostMessage, type WebviewToHost } from '../protocol';
import { Markdown } from './richText';
import { formatDuration, toolLabel } from './tools';
import { EditCard, WalkthroughCard } from './cards';
import { barModel } from './changes';
import { FilesBar, Toast } from './filesBar';
import { Composer } from './composerView';
import { PlanCard } from './planCard';
import { ApprovalCard } from './approvalCard';
import { isNearBottom, isThinking, streamingId } from './view';
import { initialState, isBusy, reducePanel, type TimelineItem } from './state';
import { Logo } from './logo';

/**
 * The Swage agent panel (blueprint sections 3 and 4): a Preact webview bundled into
 * dist/webview.js. It only exchanges validated messages with the extension host.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewToHost): void => vscode.postMessage(msg);
/** Render context for the memoised items: which message streams, whether the bar shows. */
let streamingNow: string | undefined;
let barShown = false;
/** The App's dispatch for local actions (set once the App mounts). */
let dispatchLocal: (action: LocalAction) => void = () => undefined;

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

function Notice({ item }: { item: Extract<TimelineItem, { kind: 'notice' }> }) {
  const back = item.switchBack;
  return (
    <div
      class={`notice notice-${item.tone}${item.stopped ? ' notice-stopped' : ''}`}
      role={item.tone === 'error' ? 'alert' : undefined}
    >
      {item.stopped && (
        <span class="stopped-chip">
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
          Stopped
        </span>
      )}
      <span class="notice-text">
        {item.text}
        {item.stopped ? ' Staged edits were discarded.' : ''}
      </span>
      {back && (
        <button
          type="button"
          class="link"
          aria-label={`Switch back to ${back.label}`}
          onClick={() => send({ type: 'selectModel', name: back.name })}
        >
          Switch back
        </button>
      )}
      {item.retry && (
        <button
          type="button"
          class="mini"
          aria-label="Retry the request"
          onClick={() => send({ type: 'retry' })}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** One timeline entry. Unchanged entries keep their object, so only the streaming one re-renders. */
class ItemView extends Component<{ item: TimelineItem; streaming: boolean; bar: boolean }> {
  override shouldComponentUpdate(next: {
    item: TimelineItem;
    streaming: boolean;
    bar: boolean;
  }): boolean {
    return (
      next.item !== this.props.item ||
      next.streaming !== this.props.streaming ||
      next.bar !== this.props.bar
    );
  }

  override render() {
    return <Item item={this.props.item} />;
  }
}

function Thinking() {
  return (
    <div class="turn thinking" role="status" aria-label="Swage is thinking">
      <span class="avatar">
        <Logo size={20} />
      </span>
      <span class="dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
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
          <div class={`msg assistant${item.id === streamingNow ? ' streaming' : ''}`}>
            <Markdown text={item.text} send={send} />
          </div>
        </div>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'plan':
      return (
        <PlanCard
          item={item}
          send={send}
          event={(event) => dispatchLocal({ type: 'local.plan', id: item.id, event })}
        />
      );
    case 'approval':
      return <ApprovalCard item={item} send={send} barVisible={barShown} />;
    case 'notice':
      return <Notice item={item} />;
    case 'edit':
      return <EditCard item={item} send={send} />;
    case 'walkthrough':
      return <WalkthroughCard item={item} send={send} onView={viewFilesBar} />;
  }
}

/** The Walkthrough's "View": bring the files-changed bar into view and focus it. */
function viewFilesBar(): void {
  const bar = document.getElementById('files-bar');
  bar?.scrollIntoView({ block: 'nearest' });
  bar?.focus();
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
  const [state, dispatch] = useReducer(reducePanel, initialState);
  dispatchLocal = dispatch;
  const bottom = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const msg = parseHostMessage(e.data);
      if (msg) dispatch(msg);
    };
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Auto-scroll follows the thread until the user scrolls up; "Jump to latest" brings it back.
  useEffect(() => {
    const el = thread.current;
    // Instant, not smooth: a smooth scroll's intermediate positions would look like the user
    // scrolling up and switch following off.
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [state.timeline, follow, state.status, state.changes]);
  const onScroll = (): void => {
    const el = thread.current;
    if (el) setFollow(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  };
  const bar = barModel(state);
  streamingNow = streamingId(state);
  barShown = bar.visible;

  // The "Applied N files. Undo" toast stays 10 s.
  const toastId = state.toast?.id;
  useEffect(() => {
    if (toastId === undefined) return undefined;
    const t = setTimeout(() => dispatch({ type: 'local.dismissToast', id: toastId }), 10_000);
    return () => clearTimeout(t);
  }, [toastId]);

  return (
    <div class="panel">
      {state.budget && (
        <header>
          <BudgetMeter {...state.budget} />
        </header>
      )}
      <main
        class="timeline"
        ref={thread}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        onScroll={onScroll}
      >
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
          <ItemView
            key={item.id}
            item={item}
            streaming={item.id === streamingNow}
            bar={bar.visible}
          />
        ))}
        {isThinking(state) && <Thinking />}
        <div ref={bottom} />
        {!follow && (
          <button
            type="button"
            class="jump-latest"
            aria-label="Jump to the latest message"
            onClick={() => {
              setFollow(true);
              const el = thread.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            Jump to latest ↓
          </button>
        )}
      </main>
      <footer>
        <FilesBar model={bar} send={send} />
        {state.toast && (
          <Toast
            text={state.toast.text}
            undo={state.toast.undo}
            onUndo={() => {
              send({ type: 'undo' });
              dispatch({ type: 'local.dismissToast', id: state.toast?.id ?? -1 });
            }}
            onClose={() => dispatch({ type: 'local.dismissToast', id: state.toast?.id ?? -1 })}
          />
        )}
        {state.statusMessage && isBusy(state.status) && (
          <div class="status" role="status">
            {state.statusMessage}
          </div>
        )}
        <Composer state={state} send={send} />
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
