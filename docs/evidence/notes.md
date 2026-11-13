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

### 5. Strict-judge audit and the final rehearsals (12 and 13 November)

**Fixes found by the audit and these rehearsals,** each in its own commit:

- `run_tests` uses the workspace venv for a bare `pytest`.
- `run_tests` copies tracked test fixtures: Flask's `tests/test_apps/.env` was missing, so `test_load_dotenv` failed on unchanged Flask.
- A change set reaches review only after it passed `run_tests` once.
- An agent that stops with staged edits, or gives up, opens them for review.
- A free tier's per-minute quota is waited out; switches are capped at 6 per task.
- A model that writes tool calls as text hands the task on.
- New tasks return to a profile once its rate limit is over.
- Undo after a reload is proven in VS Code.
- CI runs on Linux and macOS.
- The rehearsal set-up was fixed: Python 3.10+, `.venv/.gitignore`, and the clone kept outside the temp folder.

**Lost evidence (12 November):** the 12 November final rehearsal ran from a fresh clone in the system temp folder, which macOS cleared on restart, so its files are gone. Results from the session transcript:
- cancel passed (20 ms);
- Task A 5 of 5 (5.8, 5.4, 4.2, 3.9 and 40.5 s);
- Task C 3 of 3, including run C1 as the statement words it (unreachable endpoint configured), with lag of 137, 10 and 19 ms;
- every Task B run failed on Gemini's input-tokens-per-minute quota.

**13 November, from this repository** (`docs/evidence/2026-11-13-*`):

- **`04-49-01`:**
  - Cancel passed (13 ms).
  - Task A runs 1 to 4 passed (4.1 to 4.6 s).
  - Task C 3 of 3.
  - Task B run 1 found all three files (`cli.py`, `test_cli.py`, `docs/cli.rst`); `flask --help` listed `config` and the JSON was masked, but the model's own `test_config_command` failed. The run finished on Ollama after all three Gemini buckets hit their per-minute limit.
  - Task B runs 2 and 3, and Task A run 5, ran on Ollama, which wrote its tool calls as text, and did nothing (now handled: the next profile takes over).
- **`05-02-15`:**
  - Double undo passed (Task A applied, undone twice, `git status` clean).
  - Task B runs 1 to 3 reached review with 2, 2 and 3 files, but each one hit the 6-switch cap between rate-limited Gemini buckets. They were give-up reviews of unfinished work: tests failed and masking was missing.
- **`05-24-13` (Ollama Qwen 7B alone):** the first answer was a tool call written as text, so the run ended with one clear error after 45 s and the workspace was unchanged.

**Conclusion.** Every Swage behaviour Task B depends on works with real models:
- discovering files without being told;
- the plan with reasons;
- staging, the test gate and review;
- fallback and the give-up review;
- undo.

What failed is model capacity, not Swage. No model available to this team today can finish Task B reliably:
- **Gemini free tier:** 250,000 input tokens per minute per model, and each agent turn resends the whole conversation.
- **Ollama Qwen 7B:** no native tool calls through TrueForge.
- **Groq:** the key has no access to the configured model.

**For the recording:**
- a paid Gemini key, or Groq with a model the key can use (for example `openai/gpt-oss-120b`, configured in TrueForge);
- or an Ollama model with tool support (for example `qwen2.5:7b` or `llama3.1:8b`), added in the panel with **Other models… → Add a model from TrueForge…**.

The statement scores behaviour, not the model, and the organisers may repeat tasks with their own model.

### 6. After the panel redesign (13 November, afternoon)

Three rehearsals against the live TrueForge 0.184.2, on the redesigned panel (code at `93c632a`, then `4f2010b`):

- **`2026-11-13-13-39-28`: cancel, Task A ×3, toggle, double undo, Task C ×2. Every one passed.**
  - **Cancel:** the Stop reached the screen in 17 ms; the workspace was clean.
  - **Task A:** the diff appeared in 4.3, 5.4 and 4.9 s. `FLASK_DEBUG=off` gave `False`, and all 490 Flask tests passed.
  - **Task C:** "Switched to Gemini because the primary refused the connection"; Reject all left the workspace clean; the editor lagged at most 24 ms.
  - **Double undo:** clean afterwards, and a third undo reported `nothing_to_undo`.
  - **Task B (inside the undo step):** the command was in `flask --help` and the JSON was masked, but it added no test. The agent declared `tests/test_cli.py`, hit the 30,000-token read budget reading it whole, and a free-tier 429 moved the task to a model that submitted without the test. **Fixed in `4f2010b`:** a submit that leaves a declared file without an edit is sent back once, naming the file.
- **`2026-11-13-13-46-30`: Task B, default profiles.** The test was staged this time, but the agent placed the new command inside `routes_command`, which broke a test. Free-tier 429s (15 requests per minute, 250,000 input tokens per minute) switched models four times. The last model wrote its tool call as text.
- **`2026-11-13-13-52-30`: Task B, Gemini 3.5 Flash as primary.** Its first request was refused with a 429. The three Gemini models then switched among each other eight times. The final staged test had a syntax error.
  - This run exposed a **Swage bug**: tool results are redacted, so the agent saw `API_TOKEN = "[REDACTED:…]"` in its own staged test and used that line as an edit anchor, which never matched. **Fixed in `e3b43af`:** a marker inside an anchor matches the hidden value on that line, and the value is put back if the replacement keeps the marker. The secret still never reaches the model.
- **Groq:** `groq/llama-3-3-70b-versatile` is now configured in TrueForge but still answers 404, so the key has no access to it.

**Conclusion:** the panel redesign broke nothing. The Task B failures come from free-tier rate limits and the strength of the Flash Lite models, and the two Swage defects they exposed are fixed. Recording Task B still needs one capable model with enough quota (`docs/SUBMISSION_CHECKLIST.md`).

### 7. Making Task B fast on free models (13 November, evening)

Recording Task B can't cut between the instruction and the diff, so it has to finish fast. Gemini's free tier allows about 15 requests per minute per model, and Task B was making 40 to 71. Changes, each with tests:

- **`71d4604`:** the first message carries code excerpts of the top four retrieved files, and the agent is asked to batch tool calls. A short rate limit is waited out on the same model and session (`swage.rateLimitWaitSeconds`, now 60 s) instead of switching.
- **`530cc34`:** a tool call with a missing argument crashed while its row was shown, and the run hung. Fixed.
- **`b426ca9`:** at most 8 searches per task; past that the tool names the files found and asks for reads, the plan and edits.
- **`6e0d6f6`:** a test guard. `stage_edit` warns, and the first submit is sent back, when an edit loses existing tests (one run put its test inside `class TestRoutes`, so 3 tests silently stopped running). The rehearsal now fails Task B when any test is lost.
- **`f6129f5`:** `inlineOnly` profiles. The local qwen2.5-coder:3b ended two runs badly after Gemini's quota ran out; agent mode no longer uses it.

| Rehearsal              | Result                                                                                       | Time to review | Tool calls | 429s | Switches |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------- | ---------- | ---- | -------- |
| `2026-11-13-16-06-11`  | **Pass**: 3 files, tests pass, `config` in `--help`, masked                                    | 5.7 min        | 52         | 7    | 5        |
| `2026-11-13-16-16-06`  | Pass by the old check, but 3 existing tests silently lost (led to the test guard)             | **2.1 min**    | 26         | 2    | 0        |
| `2026-11-13-16-22-02`  | Fail: finished by the local 3B model (led to `inlineOnly`)                                    | 4.9 / 2.0 min  | 53 / 16    | 7/6  | 4 / 2    |
| `2026-11-13-16-34-09`  | Fail: 1 or 2 failing tests, not masked; Gemini's quota was worn down by the day's rehearsals | 4.4 / 5.0 min  | 64 / 86    | 6/9  | 3 / 6    |

**Conclusion:**
- Swage's part works: retrieval, planning, staging, gates, review, apply.
- Free Flash Lite models finish Task B correctly only some of the time. The best run took 2.1 minutes, and it came first after a pause, when the per-minute and daily quotas were fresh.
- For the video: record Task B first, at the start of a session with fresh quota, and keep a take that passes.
