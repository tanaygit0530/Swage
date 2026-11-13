import type { WebviewToHost } from '../protocol';
import type { TimelineItem } from './state';
import { approvalView } from './view';

/**
 * An approval card (redesign step 7): the exact command, its reason, Allow and Deny. The
 * change-set card is decided in the files-changed bar, so it only points there.
 */

type Send = (msg: WebviewToHost) => void;

export function ApprovalCard({
  item,
  send,
  barVisible,
}: {
  item: Extract<TimelineItem, { kind: 'approval' }>;
  send: Send;
  barVisible: boolean;
}) {
  const v = approvalView(item);
  const pending = item.decision === 'pending';
  if (item.name === 'submit_change_set' && barVisible && pending)
    return (
      <div class="card approval approval-review" role="group" aria-label={v.title}>
        <div class="card-body">
          <span class="card-title">{v.title}</span>{' '}
          <span class="card-sub">
            in the files-changed bar below: Accept all, Reject all, or decide per file and block.
          </span>
        </div>
      </div>
    );
  return (
    <div class={`card approval approval-${item.decision}`} role="group" aria-label={v.title}>
      <div class="card-body">
        <div class="card-title approval-title">{v.title}</div>
        <pre class="approval-command">{v.body}</pre>
        {v.reason && <div class="reason">Reason: {v.reason}</div>}
        {pending ? (
          <div class="actions">
            <button
              type="button"
              class="primary"
              aria-label={`${v.allow}: ${v.body}`}
              onClick={() => send({ type: 'approve', toolCallId: item.id, allow: true })}
            >
              {v.allow}
            </button>
            <button
              type="button"
              class="secondary"
              aria-label={`${v.deny}: ${v.body}`}
              onClick={() =>
                send({
                  type: 'approve',
                  toolCallId: item.id,
                  allow: false,
                  reason: 'Denied by the user',
                })
              }
            >
              {v.deny}
            </button>
          </div>
        ) : (
          <div class={`decision decision-${item.decision}`}>
            {item.decision === 'allowed' ? '✓ Allowed' : '✗ Denied'}
          </div>
        )}
      </div>
    </div>
  );
}
