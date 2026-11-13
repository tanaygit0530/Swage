import { useState } from 'preact/hooks';
import type { WebviewToHost } from '../protocol';
import { Counts } from './cards';
import { barTitle, type BarModel, type BarRow } from './changes';
import { splitPath } from './fileIcon';
import { FileGlyph } from './richText';

/**
 * The files-changed bar (redesign step 4): sticky above the composer, one row per changed file
 * (ordered by path) with its change blocks behind an expand toggle, and a footer with
 * "N Files With Changes", Reject all and Accept all. Decisions go through the existing review
 * commands; Accept all uses the atomic apply with hash checks.
 */

type Send = (msg: WebviewToHost) => void;

function ExpandBox({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="12"
        height="12"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
      />
      <path d="M5 8h6" stroke="currentColor" stroke-width="1.4" />
      {!open && <path d="M8 5v6" stroke="currentColor" stroke-width="1.4" />}
    </svg>
  );
}

const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.7" />
  </svg>
);

const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" />
  </svg>
);

const DECISION_LABEL = {
  pending: 'not reviewed yet',
  accepted: 'accepted',
  rejected: 'rejected',
  partial: 'partly accepted',
} as const;

function Row({
  row,
  open,
  toggle,
  canDecide,
  send,
}: {
  row: BarRow;
  open: boolean;
  toggle: () => void;
  canDecide: boolean;
  send: Send;
}) {
  const { name, dir } = splitPath(row.path);
  const blocks = row.blocks.length;
  return (
    <li class={`fb-row decision-${row.decision}${row.editing ? ' editing' : ''}`}>
      <div class="fb-line">
        <button
          type="button"
          class="icon-button fb-expand"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the ${blocks} change block${blocks === 1 ? '' : 's'} of ${row.path}`}
          title={open ? 'Hide change blocks' : 'Show change blocks'}
          disabled={blocks === 0}
          onClick={toggle}
        >
          <ExpandBox open={open} />
        </button>
        <button
          type="button"
          class="fb-main"
          title={`Open the diff of ${row.path} (${DECISION_LABEL[row.decision]})`}
          aria-label={`Open the diff of ${row.path}, +${row.added} -${row.removed}, ${DECISION_LABEL[row.decision]}${row.editing ? ', still being edited' : ''}`}
          onClick={() => send({ type: 'openDiff', path: row.path })}
        >
          <Counts added={row.added} removed={row.removed} />
          <FileGlyph path={row.path} />
          <span class="fb-name">{name}</span>
          {dir && <span class="fb-dir">{dir}</span>}
          {row.kind !== 'modify' && (
            <span class="fb-kind">{row.kind === 'create' ? 'new' : 'deleted'}</span>
          )}
        </button>
        {row.editing && (
          <span
            class="spinner"
            role="img"
            aria-label="Being edited"
            title="The agent is editing this file"
          />
        )}
        {!row.editing && row.decision === 'accepted' && (
          <span class="fb-state ok" title="Accepted">
            <Tick />
          </span>
        )}
        {canDecide && (
          <span class="fb-row-actions">
            <button
              type="button"
              class="icon-button"
              title="Accept this file"
              aria-label={`Accept every block of ${row.path}`}
              onClick={() => send({ type: 'reviewAction', action: 'acceptFile', path: row.path })}
            >
              <Tick />
            </button>
            <button
              type="button"
              class="icon-button"
              title="Reject this file"
              aria-label={`Reject every block of ${row.path}`}
              onClick={() => send({ type: 'reviewAction', action: 'rejectFile', path: row.path })}
            >
              <Cross />
            </button>
          </span>
        )}
      </div>
      {open && blocks > 0 && (
        <ol class="fb-blocks" aria-label={`Change blocks of ${row.path}`}>
          {row.blocks.map((b, i) => (
            <li class={`fb-block state-${b.state}`}>
              <button
                type="button"
                class="fb-block-main"
                title={`Open the diff at line ${b.line}`}
                aria-label={`Block ${i + 1} of ${blocks} at line ${b.line}, +${b.added} -${b.removed}, ${b.state}: ${b.summary}`}
                onClick={() => send({ type: 'openDiff', path: row.path, blockId: b.id })}
              >
                <span class="fb-block-line">L{b.line}</span>
                <Counts added={b.added} removed={b.removed} />
                <span class="fb-block-summary">{b.summary}</span>
              </button>
              {canDecide && (
                <span class="fb-block-actions">
                  <button
                    type="button"
                    class={`mini${b.state === 'accepted' ? ' on' : ''}`}
                    aria-pressed={b.state === 'accepted'}
                    aria-label={`Accept block ${i + 1} of ${row.path}`}
                    onClick={() =>
                      send({
                        type: 'reviewAction',
                        action: 'acceptBlock',
                        path: row.path,
                        blockId: b.id,
                      })
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    class={`mini${b.state === 'rejected' ? ' on' : ''}`}
                    aria-pressed={b.state === 'rejected'}
                    aria-label={`Reject block ${i + 1} of ${row.path}`}
                    onClick={() =>
                      send({
                        type: 'reviewAction',
                        action: 'rejectBlock',
                        path: row.path,
                        blockId: b.id,
                      })
                    }
                  >
                    Reject
                  </button>
                  {(b.added > 1 || b.removed > 1) && (
                    <button
                      type="button"
                      class="mini"
                      aria-label={`Split block ${i + 1} of ${row.path} into line-sized blocks`}
                      onClick={() =>
                        send({
                          type: 'reviewAction',
                          action: 'splitBlock',
                          path: row.path,
                          blockId: b.id,
                        })
                      }
                    >
                      Split
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function FilesBar({ model, send }: { model: BarModel; send: Send }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!model.visible) return null;
  const toggle = (path: string): void => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };
  const waiting = 'Available when the agent submits the change set';
  return (
    <section id="files-bar" class="files-bar" tabIndex={-1} aria-label={barTitle(model.files)}>
      {!collapsed && (
        <ul class="fb-rows">
          {model.rows.map((r) => (
            <Row
              key={r.path}
              row={r}
              open={open.has(r.path)}
              toggle={() => toggle(r.path)}
              canDecide={model.canDecide}
              send={send}
            />
          ))}
        </ul>
      )}
      <div class="fb-footer">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <span class="fb-title">{barTitle(model.files)}</span>
        <Counts added={model.added} removed={model.removed} />
        {model.phase === 'staging' && <span class="fb-hint">Agent is editing…</span>}
        <span class="spacer" />
        {model.canApplyAccepted && (
          <button
            type="button"
            class="link"
            aria-label={`Apply the ${model.accepted} accepted block${model.accepted === 1 ? '' : 's'} only`}
            onClick={() => send({ type: 'applyAccepted' })}
          >
            Apply accepted
          </button>
        )}
        <button
          type="button"
          class="text-button"
          disabled={!model.canDecide}
          title={model.canDecide ? 'Discard every change; the workspace stays unchanged' : waiting}
          aria-label="Reject all changes"
          onClick={() => send({ type: 'rejectAll' })}
        >
          Reject all
        </button>
        <button
          type="button"
          class="primary"
          disabled={!model.canDecide}
          title={model.canDecide ? 'Accept every block and apply' : waiting}
          aria-label="Accept all changes and apply them"
          onClick={() => send({ type: 'acceptAll' })}
        >
          Accept all
        </button>
        <button
          type="button"
          class="icon-button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show the changed files' : 'Hide the changed files'}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => setCollapsed(!collapsed)}
        >
          <svg
            class={`chevron-v${collapsed ? '' : ' open'}`}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M3.5 6L8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </button>
      </div>
    </section>
  );
}

export function Toast({
  text,
  undo,
  onUndo,
  onClose,
}: {
  text: string;
  undo: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <div class="toast" role="status">
      <span>{text}</span>
      {undo && (
        <button
          type="button"
          class="link"
          aria-label="Undo the applied change set"
          onClick={onUndo}
        >
          Undo
        </button>
      )}
      <span class="spacer" />
      <button type="button" class="icon-button" aria-label="Dismiss" onClick={onClose}>
        <Cross />
      </button>
    </div>
  );
}
