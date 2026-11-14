import { useEffect, useRef, useState } from 'preact/hooks';
import type { CompletionItem, WebviewToHost } from '../protocol';
import {
  applyWorkflow,
  placeholder,
  rankCompletions,
  rowsFor,
  sendButton,
  slashQuery,
  workflowsFor,
  type Workflow,
} from './composer';
import { FileGlyph } from './richText';
import { applyCompletion, mentionQuery, type PanelState } from './state';

/**
 * The composer (redesign step 5): a rounded box with an auto-growing textarea, the "@" and "/"
 * popups, and a bottom row with "+", the mode and model dropdowns, and the round Send / Stop
 * button. Enter sends, Shift+Enter adds a line, Escape stops a run (or closes a popup).
 */

type Send = (msg: WebviewToHost) => void;

/** The next frame (a timeout where there is no requestAnimationFrame, as in tests). */
const nextFrame = (f: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(f);
  else setTimeout(f, 0);
};

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

interface MenuOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly tag?: string;
  readonly dot?: 'ok' | 'failed' | 'unknown';
}

/** A small menu that opens upwards from a button, with keyboard navigation. */
export function Dropdown({
  label,
  ariaLabel,
  options,
  value,
  onSelect,
  footer,
  disabled,
  dot,
}: {
  label: string;
  ariaLabel: string;
  options: readonly MenuOption[];
  value: string;
  onSelect: (value: string) => void;
  footer?: string | undefined;
  disabled?: boolean;
  dot?: MenuOption['dot'];
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);
  const choose = (i: number): void => {
    const o = options[i];
    setOpen(false);
    buttonRef.current?.focus();
    if (o) onSelect(o.value);
  };
  return (
    <span class="dropdown">
      <button
        ref={buttonRef}
        type="button"
        class="dropdown-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${label}`}
        title={ariaLabel}
        disabled={disabled}
        onClick={() => {
          setActive(
            Math.max(
              0,
              options.findIndex((o) => o.value === value),
            ),
          );
          setOpen(!open);
        }}
      >
        <svg class="chevron-up" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 10L8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
        {dot && <span class={`health health-${dot}`} aria-hidden="true" />}
        <span class="dropdown-label">{label}</span>
      </button>
      {open && (
        <ul
          ref={listRef}
          class="menu"
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${ariaLabel}-opt-${active}`}
          onBlur={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
              setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => (a + 1) % options.length);
            else if (e.key === 'ArrowUp')
              setActive((a) => (a - 1 + options.length) % options.length);
            else if (e.key === 'Enter' || e.key === ' ') choose(active);
            else if (e.key === 'Escape' || e.key === 'Tab') {
              setOpen(false);
              buttonRef.current?.focus();
            } else return;
            e.preventDefault();
          }}
        >
          {options.map((o, i) => (
            <li
              id={`${ariaLabel}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              class={`menu-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {o.dot && (
                <span
                  class={`health health-${o.dot}`}
                  role="img"
                  aria-label={
                    o.dot === 'failed'
                      ? 'failed recently'
                      : o.dot === 'ok'
                        ? 'active'
                        : 'not used yet'
                  }
                />
              )}
              <span class="menu-main">
                <span class="menu-label">
                  {o.value === value ? '✓ ' : ''}
                  {o.label}
                </span>
                {o.detail && <span class="menu-detail">{o.detail}</span>}
              </span>
              {o.tag && <span class="menu-tag">{o.tag}</span>}
            </li>
          ))}
          {footer && (
            <li class="menu-footer" role="presentation">
              {footer}
            </li>
          )}
        </ul>
      )}
    </span>
  );
}

const MORE_MODELS = '__more__';

/** The model menu: profiles in order (primary, fallback-1, …) with a health dot. */
export function modelOptions(models: PanelState['models']): MenuOption[] {
  return [
    ...models.items.map((m, i) => ({
      value: m.name,
      label: m.label,
      detail: m.note ? `${m.model} · ${m.note}` : m.model,
      tag: i === 0 ? 'primary' : `fallback-${i}`,
      dot: (m.note ? 'failed' : m.name === models.active ? 'ok' : 'unknown') as MenuOption['dot'],
    })),
    {
      value: MORE_MODELS,
      label: 'Other models…',
      detail: 'Add any TrueForge model, or change the primary',
    },
  ];
}

type Popup =
  { kind: 'mention'; items: CompletionItem[] } | { kind: 'slash'; items: Workflow[] } | undefined;

export function Composer({ state, send }: { state: PanelState; send: Send }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const [popupKind, setPopupKind] = useState<'mention' | 'slash' | undefined>(undefined);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);

  const button = sendButton(state.status, state.stopping);
  const running = button !== 'send';

  // Cmd+L from the host.
  useEffect(() => {
    if (state.focusSeq > 0) input.current?.focus();
  }, [state.focusSeq]);

  // "+" and workflows: the host sends text to insert at the cursor.
  const attachmentId = state.attachment?.id;
  useEffect(() => {
    const a = state.attachment;
    if (!a) return;
    const el = input.current;
    const at = el?.selectionStart ?? text.length;
    const sep = at > 0 && !/\s$/.test(text.slice(0, at)) ? ' ' : '';
    const next = `${text.slice(0, at)}${sep}${a.text}${text.slice(at)}`;
    setText(next);
    nextFrame(() => {
      el?.focus();
      const c = at + sep.length + a.text.length;
      el?.setSelectionRange(c, c);
    });
  }, [attachmentId]);

  const popup: Popup =
    popupKind === 'mention'
      ? { kind: 'mention', items: rankCompletions(state.completions.items, query).slice(0, 12) }
      : popupKind === 'slash'
        ? { kind: 'slash', items: workflowsFor(query) }
        : undefined;
  const count = popup?.items.length ?? 0;

  const onInput = (value: string, cursor: number): void => {
    setText(value);
    const m = mentionQuery(value, cursor);
    const sl = m ? undefined : slashQuery(value, cursor);
    if (m) {
      requestId.current++;
      send({ type: 'complete', requestId: requestId.current, query: m.query });
      setPopupKind('mention');
      setQuery(m.query);
      setSelected(0);
    } else if (sl) {
      setPopupKind('slash');
      setQuery(sl.query);
      setSelected(0);
    } else setPopupKind(undefined);
  };

  const place = (next: { text: string; cursor: number }): void => {
    setText(next.text);
    setPopupKind(undefined);
    nextFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const choose = (i: number): void => {
    const cursor = input.current?.selectionStart ?? text.length;
    if (popup?.kind === 'mention') {
      const item = popup.items[i];
      if (item) place(applyCompletion(text, cursor, item.insertText));
    } else if (popup?.kind === 'slash') {
      const w = popup.items[i];
      if (!w) return;
      place(applyWorkflow(text, cursor, w));
      if (w.attach) send({ type: 'attach', what: w.attach });
    }
  };

  const submit = (): void => {
    if (running || text.trim() === '') return;
    send({ type: 'submit', text: text.trim() });
    setText('');
    setPopupKind(undefined);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (count > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((s) => (s + d + count) % count);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        choose(selected);
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Escape') {
      if (popupKind) setPopupKind(undefined);
      else if (button === 'stop') send({ type: 'stop' });
      else return;
      e.preventDefault();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      submit();
      e.preventDefault();
    }
  };

  const active = state.models.items.find((m) => m.name === state.models.active);
  const listId = 'composer-popup';
  return (
    <div class="composer">
      {popup && count > 0 && (
        <ul
          class="popup"
          id={listId}
          role="listbox"
          aria-label={popup.kind === 'mention' ? 'Mention a file or symbol' : 'Workflows'}
        >
          {popup.kind === 'mention'
            ? popup.items.map((c, i) => (
                <li
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  class={i === selected ? 'selected' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(i);
                  }}
                >
                  {c.kind === 'file' ? (
                    <FileGlyph path={c.label} />
                  ) : (
                    <span class="symbol-mark" aria-hidden="true">
                      ƒ
                    </span>
                  )}
                  <span class="popup-label">{c.label}</span>
                  <span class="popup-detail">{c.detail}</span>
                </li>
              ))
            : popup.items.map((w, i) => (
                <li
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  class={i === selected ? 'selected' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(i);
                  }}
                >
                  <span class="slash-mark" aria-hidden="true">
                    /
                  </span>
                  <span class="popup-label">{w.label}</span>
                  <span class="popup-detail">{w.description}</span>
                </li>
              ))}
        </ul>
      )}
      {state.comments.length > 0 && (
        <div class="comment-chips" role="group" aria-label="Review comments for the agent">
          <span
            class="chip comment-chip"
            title={state.comments.map((c) => `${c.path}:${c.lines} ${c.text}`).join('\n')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              />
            </svg>
            <span>
              {state.comments.length} Comment{state.comments.length === 1 ? '' : 's'}
            </span>
          </span>
          <span class="card-sub">sent with your next message</span>
          <button
            type="button"
            class="icon-button"
            aria-label="Clear the review comments"
            title="Clear the review comments"
            onClick={() => send({ type: 'clearComments' })}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </button>
        </div>
      )}
      <div class="composer-box">
        <textarea
          ref={input}
          rows={rowsFor(text)}
          value={text}
          aria-label="Message Swage"
          aria-autocomplete="list"
          aria-controls={popup ? listId : undefined}
          aria-activedescendant={popup && count > 0 ? `${listId}-${selected}` : undefined}
          placeholder={placeholder(MAC)}
          onInput={(e) => {
            const el = e.currentTarget;
            onInput(el.value, el.selectionStart);
          }}
          onBlur={() => setPopupKind(undefined)}
          onKeyDown={onKeyDown}
        />
        <div class="composer-row">
          <button
            type="button"
            class="icon-button"
            title="Attach the selection, or the active file"
            aria-label="Attach the selection or the active file"
            onClick={() => send({ type: 'attach', what: 'auto' })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
          <Dropdown
            label={state.mode === 'planning' ? 'Planning' : 'Fast'}
            ariaLabel="Mode"
            value={state.mode}
            disabled={running}
            options={[
              {
                value: 'planning',
                label: 'Planning',
                detail: 'Approve the plan before any edit is staged',
              },
              { value: 'fast', label: 'Fast', detail: 'Run straight through; review at the end' },
            ]}
            onSelect={(v) => send({ type: 'setMode', mode: v === 'fast' ? 'fast' : 'planning' })}
          />
          {state.models.items.length > 0 ? (
            <Dropdown
              label={active?.label ?? state.models.active}
              ariaLabel="Model"
              value={state.models.active}
              disabled={running}
              dot={active?.note ? 'failed' : 'ok'}
              options={modelOptions(state.models)}
              footer={state.autoFallback ? 'auto-fallback on' : undefined}
              onSelect={(v) =>
                send(v === MORE_MODELS ? { type: 'moreModels' } : { type: 'selectModel', name: v })
              }
            />
          ) : (
            <span class="model-name" title={state.model}>
              {state.model}
            </span>
          )}
          <span class="spacer" />
          {button === 'send' ? (
            <button
              type="button"
              class="round send"
              title="Send (Enter)"
              aria-label="Send"
              disabled={text.trim() === ''}
              onClick={submit}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 13V3.5M3.5 8L8 3.5 12.5 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              class={`round stop${button === 'stopping' ? ' stopping' : ''}`}
              title={button === 'stopping' ? 'Stopping…' : 'Stop (Escape)'}
              aria-label={button === 'stopping' ? 'Stopping…' : 'Stop'}
              disabled={button === 'stopping'}
              onClick={() => send({ type: 'stop' })}
            >
              {button === 'stopping' ? (
                <span class="spinner" aria-hidden="true" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
      {button === 'stopping' && (
        <div class="stopping-note" role="status">
          Stopping…
        </div>
      )}
    </div>
  );
}
