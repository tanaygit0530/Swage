## Findings, fixes and limitations

Written by hand during the rehearsal; `node scripts/rehearse.mjs report` appends this section to `docs/EVIDENCE.md` as it is.

### 1. Deferred-tool discovery cost three turns on every inline edit (fixed)

- **Found in:** the first real Task A run (rehearsal `2026-11-11-15-42-38`, run a-1).
- **What happened:**
  - The inline agent called `list_tools`, then `get_tool_info` twice, then `declare_context` and `stage_edit` through `call_tool`.
  - Total: 16,998 tokens and 25.9 s from instruction to diff.
- **Cause, verified in TrueForge 0.184.2's code (`trueforge-core`, `DeferredTool.js`):** for a server with `preload: false`, TrueForge tells the model to discover every tool first, even the tools listed in `preload_tools`. Details are in `docs/SPIKES.md`.
- **Fix, commit "fix(agents): call preloaded editor tools directly instead of discovering them":**
  - The inline agent now preloads its server.
  - The main agent's instructions name the tools that are already loaded.
- **Result (rehearsal `2026-11-11-15-45-50`, a-1):** direct `declare_context` then `stage_edit`, with 7,536 tokens.

### 2. Model latency and quota decide the recording model (choice recorded)

- **The slow call:** in the fixed run, the `stage_edit` model call took 24 s for 272 output tokens with 0 reasoning tokens (from TrueForge's session timeline, `scripts/spikes/session-timeline.ts`). The calls before and after took about 2 s each.
- **Measurement** (`scripts/spikes/model-latency.ts`): three runs of an edit-sized answer, about 450 tokens, through TrueForge on 11 November 2026:

| Model | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| `google-gemini/gemini-3-5-flash-lite` | 3.2 s | 6.3 s | 1.8 s |
| `google-gemini/gemini-flash-lite-latest` | 2.1 s | 1.4 s | 1.6 s |
| `google-gemini/gemini-3-6-flash` | 429 (quota) | 429 | 429 |
| `google-gemini/gemini-3-7-flash` | Headers Timeout (63.9 s) | 503 (high demand) | 429 |
| `google-gemini/gemini-flash-latest` | 429 | 429 | 429 |

- **Choice:** the rehearsal uses `gemini-flash-lite-latest` as primary and `gemini-3-5-flash-lite` as fallback-1: two separate free-tier quota buckets, both answering.
- **Limitation:** free-tier latency varies from run to run, and TrueForge retries 429s internally before reporting them (4 to 24 s above). A slow call inside a turn is most likely such a hidden retry. Swage cannot see it, apart from the first-token and stall timers.

### 3. Rehearsal `2026-11-11-15-51-37`: what failed and why

- **Passed:** cancel, Task A runs 1 to 4, Task B run 1 and Task C runs 1 to 3.
- **Failed:** Task A run 5, Task B runs 2 and 3, and the double undo.
- **B2, a harness bug (fixed):**
  - The rehearsal read the *previous* run's `done` state 6 ms after starting Task B run 2 and gave up.
  - The real run kept going. It refused Task A run 5 ("Swage is already running") and was recorded as B3.
  - The double undo then had nothing to undo, because A5 and B3 never applied.
  - Fix: the test API exposes the run's task id, the rehearsal waits for a new one, and each run first stops anything left running.
- **Gemini's "retry in" hint was ignored (fixed in Swage):**
  - Gemini's free tier answered 429 with "Quota exceeded for metric: ...input_token_count, limit: 250000 ... Please retry in 23.755608938s".
  - The classifier knew only "try again in" and Retry-After, so Swage retried after 1, 2 and 4 s and hit the limit each time.
  - Fix: it reads "retry in". A server-requested wait over 10 s switches at once to a profile not yet tried in the task.
- **Nested `read_files` arguments (fixed in Swage):**
  - Flash Lite sent `{ files: [{ files: [{ path, start_line, end_line }], path, end_line }] }`. The inner range was dropped, so the 1,153-line `cli.py` was read in full again and again, which added to the input-token total.
  - Fix: `read_files` takes the inner entries as the requests.
- **Free-tier load (limitation):**
  - Task B run 1 passed, but took 7.8 minutes: a 45 s wait for the first answer, four 503 "high demand" errors and four 429 quota errors, and one automatic switch. It made 56 tool calls.
  - Swage behaved as designed, retrying, switching and carrying the task over. The time is Google's free tier, not Swage; a paid key or a less loaded model is the remedy for the recording.

### 4. Rehearsal `2026-11-11-16-11-51` (stopped part-way)

- **Ran on:** the commit with all three fixes above. Stopped on purpose after Task B run 1, so the user could test by hand.
- **Passed:** cancel (Stop to UI 1 ms, workspace clean) and Task A runs 1 to 4 (instruction to diff 6.0 s, 14.6 s, 32.4 s and 5.2 s; 2 blocks each; `FLASK_DEBUG=off` gave `False`; all 490 Flask tests passed after Apply).
- **Failed:** Task B run 1 ended with a run error. Not investigated yet.
- **Still to run:** Task B, the double undo and Task C on this commit. Testing is deferred until the build is complete; the full rehearsal is `node scripts/rehearse.mjs run`.
