import { useState } from 'preact/hooks';
import type { WebviewToHost } from '../protocol';
import { parseInline } from './markdown';
import { planActions, planStatus, type PlanEvent } from './plan';
import { FileChip, Inlines } from './richText';
import type { TimelineItem } from './state';

/**
 * The collapsible Plan card (redesign steps 2 and 6): the plan steps and the declared files with
 * their reasons. In Planning mode it waits for Approve, or Edit with feedback.
 */

type Send = (msg: WebviewToHost) => void;

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

export function PlanCard({
  item,
  send,
  event,
}: {
  item: Extract<TimelineItem, { kind: 'plan' }>;
  send: Send;
  event: (e: PlanEvent) => void;
}) {
  const [open, setOpen] = useState(true);
  const [feedback, setFeedback] = useState('');
  const actions = planActions(item.gate);
  const status = planStatus(item.gate);
  const id = item.toolCallId;
  const decide = (approve: boolean): void => {
    if (!id) return;
    event(approve ? 'approve' : 'submitEdit');
    send({
      type: 'planDecision',
      toolCallId: id,
      approve,
      ...(approve || !feedback.trim() ? {} : { feedback: feedback.trim() }),
    });
  };
  return (
    <section class={`card plan plan-${item.gate}`} aria-label="Plan">
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
          {status && (
            <div class={`plan-status gate-${item.gate}`} role="status">
              {status}
            </div>
          )}
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
          {item.gate === 'editing' && (
            <div class="plan-edit">
              <label class="card-subtitle" for={`plan-feedback-${item.id}`}>
                What should change in the plan?
              </label>
              <textarea
                id={`plan-feedback-${item.id}`}
                rows={3}
                value={feedback}
                placeholder="For example: also update docs/cli.rst; do not touch the tests"
                onInput={(e) => setFeedback(e.currentTarget.value)}
              />
              <div class="actions">
                <button
                  type="button"
                  class="primary"
                  aria-label="Send the plan back with these changes"
                  disabled={!feedback.trim()}
                  onClick={() => decide(false)}
                >
                  Send back
                </button>
                <button
                  type="button"
                  class="secondary"
                  aria-label="Cancel editing the plan"
                  onClick={() => event('cancelEdit')}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {(actions.approve || actions.edit) && item.gate !== 'editing' && (
            <div class="actions">
              <button
                type="button"
                class="primary"
                aria-label="Approve the plan"
                disabled={actions.busy}
                onClick={() => decide(true)}
              >
                Approve
              </button>
              <button
                type="button"
                class="secondary"
                aria-label="Edit the plan"
                disabled={actions.busy}
                onClick={() => event('edit')}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
