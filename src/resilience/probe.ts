import { describeError, type SwageClient } from '../client/client';
import { classifyMessage, type Failure } from './classify';
import type { ResolvedProfile } from './profiles';

/**
 * A tiny request to one profile through TrueForge (blueprint section 8 and F8): used by the
 * recovery monitor (does it answer again?) and by Doctor (does it call a tool?). The tool probe
 * asks for one `repo_map` call on the editor tools; outside a run the tool answers
 * "no_active_task", which is fine: the point is that the model called it.
 */

export interface ProbeOptions {
  /** Require a tool call (Doctor). Without it any answer counts (recovery). */
  readonly toolCall?: boolean;
  /** MCP server name the tool lives on. */
  readonly mcpServer?: string;
  readonly timeoutMs?: number;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly ms: number;
  /** One line: what happened. */
  readonly detail: string;
  readonly failure?: Failure;
}

const PROBE_TOOL = 'repo_map';

export async function probeProfile(
  client: SwageClient,
  profile: ResolvedProfile,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? Math.min(90_000, profile.timeouts.firstTokenMs + 15_000);
  const ms = (): number => Date.now() - t0;
  let sessionId: string | undefined;
  try {
    sessionId = await client.createInlineSession({
      model: { name: profile.trueforgeModel, params: { temperature: 0, maxTokens: 256 } },
      instructions: opts.toolCall
        ? `When asked, call the ${PROBE_TOOL} tool exactly once, then reply with the word OK.`
        : 'Reply with the word OK and nothing else.',
      ...(opts.toolCall
        ? {
            mcpServers: [
              {
                name: opts.mcpServer ?? 'editor-tools',
                enableTools: [PROBE_TOOL],
                preloadTools: [PROBE_TOOL],
                requireApprovalForTools: [],
              },
            ],
          }
        : {}),
      config: {
        sandbox: { enabled: false },
        generativeUi: { enabled: false },
        askUserQuestions: { enabled: false },
        dynamicSubAgents: { enabled: false },
        iterationLimit: 3,
      },
    });
  } catch (err) {
    const failure = classifyMessage(describeError(err));
    return { ok: false, ms: ms(), detail: failure.detail, failure };
  }

  const abort = new AbortController();
  const sid = sessionId;
  const timer = setTimeout(() => {
    abort.abort();
    // Also stop the turn in TrueForge, so the stream ends even if the transport ignores the abort.
    void client.cancel(sid).catch(() => undefined);
  }, timeoutMs);
  timer.unref?.();
  let called = false;
  let text = '';
  try {
    for await (const e of client.sendMessage(
      sessionId,
      opts.toolCall ? `Call ${PROBE_TOOL} now.` : 'ping',
      { signal: abort.signal },
    )) {
      if (e.type === 'tool_start' && e.name === PROBE_TOOL) called = true;
      else if (e.type === 'text') text += e.delta;
      else if (e.type === 'error') {
        const failure = classifyMessage(e.message);
        return { ok: false, ms: ms(), detail: failure.detail, failure };
      } else if (e.type === 'cancelled') {
        return {
          ok: false,
          ms: ms(),
          detail: abort.signal.aborted
            ? `no answer in ${Math.round(timeoutMs / 1000)} s`
            : `cancelled (${e.reason})`,
        };
      } else if (e.type === 'done') {
        if (opts.toolCall && !called)
          return {
            ok: false,
            ms: ms(),
            detail: `answered without calling a tool: "${text.trim().slice(0, 60)}"`,
          };
        return {
          ok: true,
          ms: ms(),
          detail: opts.toolCall ? `called ${PROBE_TOOL}` : `answered "${text.trim().slice(0, 40)}"`,
        };
      }
    }
    return {
      ok: false,
      ms: ms(),
      detail: abort.signal.aborted
        ? `no answer in ${Math.round(timeoutMs / 1000)} s`
        : 'stream ended',
    };
  } finally {
    clearTimeout(timer);
  }
}
