// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebviewToHost } from '../../../src/ui/protocol';
import {
  planActions,
  planStatus,
  planTransition,
  type PlanGate,
} from '../../../src/ui/webview/plan';
import { PlanCard } from '../../../src/ui/webview/planCard';
import { initialState, reduce, reducePanel } from '../../../src/ui/webview/state';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('plan card state machine', () => {
  it('approves from awaiting', () => {
    let g: PlanGate = 'awaiting';
    g = planTransition(g, 'approve');
    expect(g).toBe('sending-approve');
    expect(planActions(g).busy).toBe(true);
    expect(planTransition(g, 'allowed')).toBe('approved');
  });

  it('edits, cancels, and sends back with feedback', () => {
    let g: PlanGate = planTransition('awaiting', 'edit');
    expect(g).toBe('editing');
    expect(planTransition(g, 'cancelEdit')).toBe('awaiting');
    g = planTransition(g, 'submitEdit');
    expect(g).toBe('sending-revise');
    expect(planTransition(g, 'denied')).toBe('revising');
  });

  it('goes stale when the run ends undecided, and ignores events that do not apply', () => {
    for (const g of ['awaiting', 'editing', 'sending-approve', 'sending-revise'] as const)
      expect(planTransition(g, 'runEnded')).toBe('stale');
    expect(planTransition('approved', 'runEnded')).toBe('approved');
    expect(planTransition('view', 'allowed')).toBe('view');
    expect(planTransition('view', 'denied')).toBe('view');
    expect(planTransition('view', 'approve')).toBe('view');
    expect(planTransition('approved', 'edit')).toBe('approved');
    expect(planTransition('awaiting', 'cancelEdit')).toBe('awaiting');
    expect(planTransition('awaiting', 'submitEdit')).toBe('awaiting');
  });

  it('shows buttons and a status per state', () => {
    expect(planActions('awaiting')).toEqual({ approve: true, edit: true, busy: false });
    expect(planActions('view')).toEqual({ approve: false, edit: false, busy: false });
    for (const g of [
      'awaiting',
      'editing',
      'sending-approve',
      'sending-revise',
      'approved',
      'revising',
      'stale',
    ] as const)
      expect(planStatus(g)).toBeTruthy();
    expect(planStatus('view')).toBeUndefined();
  });

  it('is driven by host messages and local actions in the reducer', () => {
    let s = reduce(initialState, {
      type: 'plan',
      steps: ['Add the command'],
      files: [{ path: 'src/flask/cli.py', reason: 'the CLI' }],
      toolCallId: 'c1',
      awaiting: true,
    });
    const id = s.timeline[0]?.id ?? '';
    expect(s.timeline[0]).toMatchObject({ kind: 'plan', gate: 'awaiting', toolCallId: 'c1' });
    s = reducePanel(s, { type: 'local.plan', id, event: 'approve' });
    expect(s.timeline[0]).toMatchObject({ gate: 'sending-approve' });
    s = reduce(s, { type: 'approval_resolved', toolCallId: 'c1', allowed: true });
    expect(s.timeline[0]).toMatchObject({ gate: 'approved' });
    // Fast mode: a read-only card.
    const fast = reduce(initialState, { type: 'plan', steps: [], files: [] });
    expect(fast.timeline[0]).toMatchObject({ gate: 'view' });
    // A run that ends while the plan waits leaves it stale.
    const ended = reduce(
      reduce(initialState, {
        type: 'plan',
        steps: [],
        files: [],
        toolCallId: 'c2',
        awaiting: true,
      }),
      { type: 'status', state: 'cancelled', message: 'Cancelled.' },
    );
    expect(ended.timeline[0]).toMatchObject({ gate: 'stale' });
  });
});

describe('plan card', () => {
  const item = {
    kind: 'plan' as const,
    id: 'plan-c1',
    steps: ['Add a `config` command', 'Test it'],
    files: [{ path: 'src/flask/cli.py', reason: 'the CLI lives here' }],
    toolCallId: 'c1',
  };

  function mount(gate: PlanGate) {
    const root = document.createElement('div');
    document.body.append(root);
    const sent: WebviewToHost[] = [];
    const events: string[] = [];
    render(
      <PlanCard
        item={{ ...item, gate }}
        send={(m) => sent.push(m)}
        event={(e) => events.push(e)}
      />,
      root,
    );
    return { root, sent, events };
  }

  it('shows the plan, files with reasons, and Approve / Edit while awaiting', () => {
    const { root, sent, events } = mount('awaiting');
    expect(root.querySelectorAll('.plan-steps li')).toHaveLength(2);
    expect(root.querySelector('.plan-files')?.textContent).toContain('the CLI lives here');
    root.querySelector<HTMLButtonElement>('[aria-label="Approve the plan"]')?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Edit the plan"]')?.click();
    expect(sent).toEqual([{ type: 'planDecision', toolCallId: 'c1', approve: true }]);
    expect(events).toEqual(['approve', 'edit']);
  });

  it('sends the plan back with feedback from the edit box', async () => {
    const { root, sent, events } = mount('editing');
    const box = root.querySelector('textarea') as HTMLTextAreaElement;
    box.value = 'also update docs/cli.rst';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    root
      .querySelector<HTMLButtonElement>('[aria-label="Send the plan back with these changes"]')
      ?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Cancel editing the plan"]')?.click();
    expect(sent).toEqual([
      {
        type: 'planDecision',
        toolCallId: 'c1',
        approve: false,
        feedback: 'also update docs/cli.rst',
      },
    ]);
    expect(events).toEqual(['submitEdit', 'cancelEdit']);
  });

  it('has no buttons once decided, or in Fast mode', () => {
    for (const gate of ['approved', 'view', 'stale'] as const) {
      const { root } = mount(gate);
      expect(root.querySelector('[aria-label="Approve the plan"]')).toBeNull();
      document.body.innerHTML = '';
    }
  });

  it('collapses', async () => {
    const { root } = mount('view');
    root.querySelector<HTMLButtonElement>('.card-head')?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector('.card-body')).toBeNull();
  });
});
