/**
 * The Plan card's state machine (redesign step 6). In Planning mode the agent's declare_context
 * waits for the user: Approve lets it run (edits may follow), Edit opens a feedback box and
 * sends the plan back. In Fast mode, or once decided, the card is read-only.
 *
 *   view      read-only plan (Fast mode, or an approved re-declaration)
 *   awaiting  Approve / Edit
 *   editing   feedback box open (Cancel goes back to awaiting)
 *   sending   a decision was sent; waiting for the host
 *   approved  the agent may stage edits
 *   revising  sent back with feedback; the agent declares a revised plan
 *   stale     the run ended before a decision
 */

export type PlanGate =
  | 'view'
  | 'awaiting'
  | 'editing'
  | 'sending-approve'
  | 'sending-revise'
  | 'approved'
  | 'revising'
  | 'stale';

export type PlanEvent =
  'approve' | 'edit' | 'cancelEdit' | 'submitEdit' | 'allowed' | 'denied' | 'runEnded';

export function planTransition(gate: PlanGate, event: PlanEvent): PlanGate {
  switch (event) {
    case 'approve':
      return gate === 'awaiting' || gate === 'editing' ? 'sending-approve' : gate;
    case 'edit':
      return gate === 'awaiting' ? 'editing' : gate;
    case 'cancelEdit':
      return gate === 'editing' ? 'awaiting' : gate;
    case 'submitEdit':
      return gate === 'editing' ? 'sending-revise' : gate;
    case 'allowed':
      return gate === 'view' ? gate : 'approved';
    case 'denied':
      return gate === 'view' ? gate : 'revising';
    case 'runEnded':
      return gate === 'awaiting' ||
        gate === 'editing' ||
        gate === 'sending-approve' ||
        gate === 'sending-revise'
        ? 'stale'
        : gate;
  }
}

/** The buttons the card shows. */
export function planActions(gate: PlanGate): { approve: boolean; edit: boolean; busy: boolean } {
  return {
    approve: gate === 'awaiting' || gate === 'editing',
    edit: gate === 'awaiting',
    busy: gate === 'sending-approve' || gate === 'sending-revise',
  };
}

export function planStatus(gate: PlanGate): string | undefined {
  switch (gate) {
    case 'awaiting':
    case 'editing':
      return 'Waiting for your approval. No edit is staged until you approve.';
    case 'sending-approve':
      return 'Approving…';
    case 'sending-revise':
      return 'Sending your changes…';
    case 'approved':
      return 'Approved';
    case 'revising':
      return 'Sent back for revision';
    case 'stale':
      return 'Not decided: the run ended';
    default:
      return undefined;
  }
}
