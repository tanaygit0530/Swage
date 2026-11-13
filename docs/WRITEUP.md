# Swage: an editor-native coding agent on TrueForge

Forge-a-thon, Techfest 2026-27, Round 1. Repository: <https://github.com/tanaygit0530/Swage>. Video: ⟨link⟩.

## 1. Team

⟨Team name⟩. ⟨Member name⟩, ⟨college or employer⟩, GitHub [@tanaygit0530](https://github.com/tanaygit0530). ⟨Add each member: name, college or employer, GitHub handle.⟩

## 2. Starting point

From scratch: no fork, no copied code. Libraries:

- TrueForge TypeScript SDK and MCP TypeScript SDK;
- zod, jsdiff, `@vscode/tree-sitter-wasm`, Preact, `ignore`, `shell-quote` and `yaml`;
- for the build: esbuild, TypeScript, Vitest and `@vscode/test-cli`.

All shipped dependencies are MIT, ISC or BSD (`npm run check:licences`).

## 3. Architecture on TrueForge

```
 VS Code extension (thin client)                      TrueForge 0.184.2 (local, npx)
 ┌──────────────────────────────────┐   SDK: sessions,   ┌───────────────────────────┐
 │ Agent panel · Inline edit        │   turns, cancel,   │ agents swage-main-<p>,    │
 │ Review view · CodeLens · Undo    │ ─ stream events ─▶ │ swage-inline-<p>          │
 │ Router (profiles, timers,        │ ◀───────────────── │ approval gate, compaction,│
 │ fallback) · Doctor               │                    │ deferred tool loading     │
 │ MCP server :127.0.0.1 + token    │ ◀── MCP tool calls │ model providers + keys    │
 │ overlay (change set), index      │      (HTTP)        │ (Gemini, Groq, Ollama…)   │
 └──────────────────────────────────┘                    └───────────────────────────┘
```

**A thin client.** The extension creates sessions and turns through the TrueForge SDK and renders the streamed events. It never calls a model.

**Tools, not logic.** Nine editor capabilities are MCP tools on a local Streamable HTTP server with a bearer token, so the agent decides what to read and change:

- `find_relevant_code`, `repo_map`, `read_files` and `get_symbol`;
- `declare_context` (the plan and files with reasons);
- `stage_edit` (anchor-checked edits to an in-memory overlay that is never written to disk);
- `run_tests` (allowlisted, run in a shadow copy);
- `run_command`;
- `submit_change_set`.

**Harness features used:**

- **Approval gated by name.** `submit_change_set` and `run_command` require approval. The pause opens the Review view, and Apply or Discard resumes the turn.
- **Deferred loading** with `preload_tools`. The five hot tools are loaded; `run_tests` and the rare tools are discovered.
- **Compaction on, iteration limits.** Limits are 30 for the main agent and 8 for the inline agent.

A rehearsal found that TrueForge tells the model to discover _every_ tool of a server with `preload: false`, including preloaded ones. The inline agent now preloads its two tools, which cut its tokens from 16,998 to 7,536 per edit.

**Review and safety.**

- Apply is one atomic WorkspaceEdit after a hash check, with two-level undo from checkpoints.
- Stop cancels the turn, aborts tool processes and discards the overlay.

**Trade-offs we chose:**

- lexical retrieval over embeddings;
- an overlay over direct writes;
- client-side fallback over a native one;
- approval gated by name;
- no sandbox: tests run in a temporary copy instead.

## 4. How context is selected

**Strategy.** Swage keeps a tree-sitter symbol index (Python, TypeScript, JavaScript), BM25 over identifiers, and an import graph, built in 221 to 239 ms for Flask's 229 files and 14 ms warm.

**The first message contains:**

- the request;
- every `@file` and `@symbol` mention (always included);
- a repo map ranked for the request (about 1,500 tokens);
- a hints block of candidate files with reasons.

**After that, the agent pulls more itself:**

- `find_relevant_code` returns snippets within a per-call budget;
- `read_files` reads line ranges, and whole-file reads count against a 9,000-token per-run budget.

**Visible in the panel.** `declare_context` makes the plan and chosen files, with reasons, visible as the Context Receipt, beside a token budget bar.

**Inline edits** get the selection, the enclosing symbol, the imports and 15 lines around, and are locked to the selected range.

| Retrieval on Flask 3.1.3 (11 labelled queries) | Result                                           |
| ---------------------------------------------- | ------------------------------------------------ |
| Mean recall@10 / recall@5                      | 1.000 / 0.970                                    |
| Task B files                                   | `cli.py` #1, `test_cli.py` #3, `docs/cli.rst` #6 |
| Task A file                                    | `helpers.py` #1                                  |
| Query time                                     | mean 2.0 ms                                      |

## 5. Model setup

**Models.** All run through TrueForge, with keys entered only in TrueForge:

- primary `google-gemini/gemini-flash-lite-latest`;
- fallback `google-gemini/gemini-3-5-flash-lite`;
- both on the Gemini free tier (cost: 0).

**Also tried:** local Ollama Qwen 7B (free; it made no native tool calls through TrueForge, so Swage hands the task on). Groq is supported, but this team's key had no access to the configured model.

**Profiles** set connect, first-token, stall and total timers; local models get longer limits.

**Fallback.**

- Hard failures (401, a refused connection, an unknown model) switch at once.
- 429 and 5xx retry with backoff and honour "retry in N s".
- The next model receives the task, plan and staged edits.

**Switching models.** One click in the agent panel's **model picker**; **Other models… → Add a model from TrueForge…** adds any model TrueForge has (for the organisers' live call). Also `swage.models`, or **Swage: Switch Model**.

## 6. Scorecard

| Criterion               | Video    | Claim                                                                                                                                                                            |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Inline edit          | ⟨mm:ss⟩  | Per-block Accept, Reject and revert in the native diff. Rehearsals: 4 to 6 s from instruction to diff when quota is free, `FLASK_DEBUG=off` → `False`, all 490 Flask tests pass. |
| A2 Agent mode           | ⟨mm:ss⟩  | No file named. The agent found `cli.py`, `test_cli.py` and `docs/cli.rst` itself and passed `test_cli.py` (59) in rehearsal; see section 8 for the models.                       |
| A3 Streaming and cancel | ⟨mm:ss⟩  | Live tokens. Stop reaches the UI in 1 to 23 ms, `git status` stays clean.                                                                                                        |
| B1 Context              | ⟨mm:ss⟩  | Plan and Context Receipt with budget bar; recall@10 of 1.000 on Flask.                                                                                                           |
| B2 Diff safety          | ⟨mm:ss⟩  | Per-block review, atomic Apply, Undo twice, clean `git status`.                                                                                                                  |
| B3 Resilience           | ⟨mm:ss⟩  | The primary drops mid-answer; automatic switch with no click; Reject all; clean `git status`. 3 of 3 runs.                                                                       |
| B4 TrueForge            | ⟨mm:ss⟩  | Session page: MCP tool calls, the approval pause and deferred `run_tests` discovery.                                                                                             |
| C1 Video                | ⟨mm:ss⟩  | A, B and C in order, each verified, no cut from instruction to diff.                                                                                                             |
| C2 Write-up             | this PDF | Architecture, strategy, trade-offs and honest limits, with measured numbers.                                                                                                     |

## 7. Tools used

- **AI coding assistant:** Claude Code (Anthropic) wrote and reviewed much of the code, tests and documentation under our direction.
- **Development:** VS Code, Node.js, Git, GitHub Actions.
- **Models:** Gemini (free tier) and Ollama Qwen 7B, through TrueForge.

## 8. Known limitations and another month

**Limitations.**

- **Free-tier limits dominate.** Inline diffs took 4 to 6 s with quota free, and up to 54 s while quotas recovered.
- **Task B needs a capable model.** Swage discovers the files, plans, stages, gates on tests and reviews correctly, but on 13 November no free model available to us could finish it. Gemini's free tier ran out of input tokens per minute mid-task, and Ollama Qwen 7B made no native tool calls. Swage waits out quotas, caps switches, and opens the unfinished edits for review instead of losing them.
- **Verification is narrow.** Swage is verified with Gemini only, and on macOS only; CI runs on Ubuntu.
- **Not yet built:**
  - A running task does not survive a window reload.
  - There is no session-log export or performance-report command.
  - The inline instruction box sits at the top of the window, not in the editor.
- **Retrieval is lexical,** so phrase-level questions miss sometimes (recall@5 is 0.883 on our own fixture).

**With another month:**

- embeddings beside BM25;
- reload-safe streams (resume by sequence number);
- a session-log export and performance report;
- Windows and Linux CI;
- a model matrix across Groq and local models;
- an inline widget once VS Code's API allows it;
- Round 2 pull requests to TrueForge, starting with the deferred-tools instruction.
