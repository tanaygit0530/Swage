# Progress

Append one entry per phase: what was built, what was tested, what is open. Blueprint section numbers are the source of truth.

## Phase 0: Project scaffold (11 November 2026)

### Built

- `package.json` manifest for the `swage` extension (publisher `swage-dev`, `engines.vscode ^1.96.0`, activation `onStartupFinished`, main `dist/extension.js`).
  - Seven commands from blueprint section 3, all shown as `Swage: …` in the Command Palette: `swage.inlineEdit`, `swage.openAgent`, `swage.stop`, `swage.reviewChanges`, `swage.undoLastChangeSet`, `swage.switchModel`, `swage.doctor`.
  - Settings from blueprint section 9: `swage.models`, `swage.budgets` (defaults from section 7), `swage.ignore`, `swage.truefoundry.baseUrl` (default `http://localhost:8790`), `swage.autoStart`.
  - Keybindings: Cmd+K Cmd+I (Ctrl+K Ctrl+I) for inline edit when the editor has focus; Escape and Cmd+Alt+. (Ctrl+Alt+.) run `swage.stop`, but only while the `swage.running` context key is true, so Escape keeps its normal meaning otherwise.
- Tooling (blueprint section 5): strict TypeScript, esbuild bundling to `dist/extension.js`, ESLint (typescript-eslint strict) with Prettier, Vitest, `@vscode/test-cli` plus `@vscode/test-electron`, `@vscode/vsce`.
- Scripts: `build` (typecheck and bundle), `watch`, `lint` (ESLint and Prettier check), `format`, `test`, `test:integration`, `package`.
- `src/extension.ts` registers every command as a stub that shows "Swage: <title> is not implemented yet." Command ids live in `src/commands.ts`, which has no `vscode` import, so they can be unit tested.
- Empty module folders from blueprint section 9, each with an `index.ts`: `supervisor`, `client`, `resilience`, `mcp`, `changeset`, `review`, `context`, `safety`, `guardrails`, `ui`.
- `.github/workflows/ci.yml`: `npm ci`, lint, test and build on push and pull request with Node 22.
- `.vscode/launch.json` and `tasks.json`: F5 runs "Run Swage Extension" with the esbuild watch task.
- `docs/BLUEPRINT.md` and `docs/PROBLEM_STATEMENT.pdf` committed.

### Tested

- `npm run lint`, `npm test` (5 Vitest tests on the manifest: commands match registration, prefix and category, keybindings, settings) and `npm run build`: all green.
- `npm run test:integration`: one test passes in VS Code stable; the extension activates and all seven commands are registered.
- `npm run package` builds `swage-0.0.1.vsix` (not committed).

### Open

- No TrueForge integration yet. The day-1 spikes in blueprint section 14 come next; record the results in `docs/SPIKES.md`.
- In stock VS Code, Cmd+K Cmd+I opens the hover popup. Swage overrides it while the editor has focus. Blueprint section 3 suggests Cmd+Alt+K instead; decide which one to keep.
- `swage.running` is never set to true yet, so the Escape binding stays inactive until runs exist.
- The other key suggestions in blueprint section 3 (Cmd+Alt+A, R and Z) are not bound yet.
- The blueprint layout mentions pnpm; this repo uses npm, as the working rules in CLAUDE.md specify.
- CI runs on Ubuntu only. Blueprint section 11 wants three operating systems plus licence and secret scans; add those later.
- npm 11 blocked the install scripts of `esbuild` and `@vscode/vsce-sign`. Build and packaging work without them; review them with `npm install-scripts ls` if signing is ever needed.

## Phase 1: Core engine, change set and safety (11 November 2026)

Pure TypeScript in `src/changeset` and `src/safety`, with no `vscode` import and no network. Blueprint sections 6 and 8.

### Built

- `changeset/blocks.ts`: change blocks are maximal runs of changed lines with zero context, computed with jsdiff (`diff`, BSD-3-Clause). `computeBlocks`, `splitBlock` (two parts at explicit offsets), `splitBlockByLine` (line-sized parts) and `applyBlocks` (accepted blocks only, in any order). Lines keep their terminators, so CRLF and a missing final newline survive. Whitespace-only blocks are flagged.
- `changeset/text.ts`: line splitting, EOL detection, `matchTextStyle` (keeps the base file's CRLF or LF and its final-newline state), SHA-256 hashing.
- `changeset/changeSet.ts`: the in-memory overlay keyed by task id, plus `ChangeSetStore`. `declareContext` (plan plus files with reasons) is required before staging. Staging supports find/replace anchors with an optional `occurrence`, full-file writes, creates and deletes. Agent-readable errors: `context_not_declared`, `undeclared_file`, `anchor_not_found` (with a hint when only whitespace differs), `anchor_ambiguous` (with `matchCount`), `bad_occurrence`, `suspicious_truncation` (rewrite under 20% of the original), `file_not_found`, `unknown_block`, `invalid_split`, `not_staging`. A batch of edits applies all or nothing. Review supports accept, reject, accept all and reject all, per file or overall, and split; split parts inherit the block's state. `result()` builds file changes from accepted blocks only.
- `changeset/symbols.ts`: regex extraction of top-level Python, TypeScript and JavaScript functions, classes and exports, behind a `SymbolExtractor` hook for tree-sitter. `checkDeletedSymbols` warns when a removed symbol is still referenced in the change set's resulting files, the same file included. Comment lines and substrings don't count as references.
- `changeset/apply.ts`: `Applier` over an injected `WorkspaceFs`. All files are hash-checked before any write: a file changed on disk, missing, or already existing refuses the whole apply. If a write fails partway, earlier writes are rolled back. Each apply records a checkpoint. Two undo levels; undo refuses if a file changed since apply, unless forced. History can be restored after a reload. Creates and deletes are handled, and content is written verbatim.
- `safety/pathGuard.ts`: workspace-only path resolution. Rejects traversal, absolute paths outside the root, and symlink escapes (checked through the deepest existing ancestor, so new files are covered). Ignores `.git`, `node_modules`, env files, keys, build output, caches, local databases and `.swageignore` patterns (gitignore syntax through `ignore`, MIT).
- `safety/redact.ts`: redacts OpenAI, Anthropic, Groq, Google, GitHub, AWS, Slack, Stripe, Hugging Face and npm keys, JWTs, Bearer tokens, URL passwords, PEM private keys (truncated blocks included) and secret-looking assignments. Ordinary code such as `os.environ` lookups, type hints and placeholders is left alone.
- `safety/commandPolicy.ts`: three outcomes. `run_test` for allowlisted pytest, `python -m pytest`, npm test, vitest, jest, go test and cargo test, returned as argv to run without a shell. `ask` for everything else. `deny` for `rm -rf`, sudo and similar, `git push`, pipe-to-shell, writes to system paths and system commands. Test commands with shell metacharacters, dangerous flags (for example `pytest -p`, `--rootdir`, `npm --script-shell`, `go test -exec`) or outside paths are denied. Parsing uses `shell-quote` (MIT).
- `scripts/verify.sh` runs lint, test and build and stops at the first failure. CI now runs `npm run test:coverage`.

### Tested

- 197 Vitest tests across 9 files, all green; lint and build green.
- Realistic Flask `get_debug_flag` edits: a separated docstring and logic change (two blocks) and an adjacent rewrite (one block), each with full, partial and none acceptance. The one-block case is split by line and only the `return` line is accepted.
- A 10-block diff with alternating acceptance; split then accept one part; nested splits.
- Apply then undo then undo again (`nothing_to_undo`); two undo levels with the oldest dropped; a hash-mismatch refusal with zero writes; rollback on a failed write; an undo refused after a user edit, then forced.
- CRLF files end to end from LF anchors through apply and undo; preserved missing final newline.
- Path traversal, absolute paths, real symlink escapes in a temp folder, and ignore rules.
- Secret redaction for every supported kind, using fake keys built at runtime, plus a list of ordinary code lines that must stay untouched.
- Coverage of `src/changeset` and `src/safety`: 99.23% statements, 95.54% branches, 100% functions, 100% lines. The threshold is 90%, enforced in CI.

### Open

- Nothing is wired into the extension yet. The MCP tools (`declare_context`, `stage_edit`, `submit_change_set`, `run_tests`) still need to call these modules.
- Change sets and checkpoints live in memory; persisting them to globalStorage (blueprint section 8) is still to do. `Applier` already accepts a restored history.
- Re-staging a file resets its block decisions to pending. That is fine during staging, but decide whether to keep decisions for unchanged blocks.
- Redaction can change text the agent later uses as a find anchor, such as a line with a literal secret. Consider a specific error for anchors that contain `[REDACTED:`.
- The symbol check only looks inside the change set, not the whole repository; the context index (blueprint section 7) can widen it later.
- The command policy is string-based. The shadow-copy runner still needs a scrubbed environment, a timeout, an output cap and a process-tree kill.

## Phase 2: Context engine (11 November 2026)

`src/context`: lexical, model-free retrieval in pure TypeScript with no `vscode` import (blueprint section 7). No model calls, no embeddings, works offline.

### Built

- `symbols.ts`: tree-sitter parsing through `@vscode/tree-sitter-wasm` (MIT, offline WASM; decision and verified API in `docs/SPIKES.md`). Covers Python, TypeScript, TSX and JavaScript: top-level and nested symbols (functions, classes, methods, constants, interfaces, types, enums, exports) with line ranges, plus import specifiers. Falls back to the Phase 1 regex extractor if the WASM files cannot load, and plugs into the change-set `SymbolExtractor` hook. The build copies the five WASM files (3.8 MB) to `dist/wasm`.
- `tokens.ts`: identifier-aware tokens. Splits snake_case, camelCase and acronyms, lowercases, drops stop words and a small suffix stemmer that undoubles consonants (`logging` matches `log`). In code files the bare `import` and `export` keywords are skipped, but they stay searchable in prose.
- `budget.ts`: token estimate (characters / 4). Budgets are read from the `swage.budgets` default in `package.json`: 5 hinted files, 4,000 tokens per tool result, 30,000 tokens of reads per run, 1,500-token repo map. `truncateToTokens` stays within the budget, marker included, and the marker says how to get more. `ReadBudget` refuses full reads past the run budget and allows ranged reads.
- `indexer.ts`: `WorkspaceIndex` walks the workspace honouring nested `.gitignore` files, `.swageignore`, the path guard's default ignores and the `swage.ignore` setting. It skips symlinks, binaries (by extension or a NUL byte) and files over 512 KB. Each file record holds path, size, mtime, hash, language, symbols, imports, token frequencies and estimated tokens. Builds are incremental by size and mtime. The cache lives in `.swage/index/index.json`, and the indexer also writes `.swage/.gitignore` containing `*`, so the target repository's `git status` stays clean (Task C). The cache location can be injected. Python (relative, absolute and package) and TypeScript/JavaScript (relative, with extensions and `index` files) imports are resolved into a forward and reverse graph. Watcher hook: `attachWatcher` / `handleEvent` process events in order; changing an ignore file triggers a rebuild, and deleting a folder removes everything under it.
- `bm25.ts`: BM25 (k1 1.2, b 0.75) over three fields: content, symbol names and path without the extension. On top come an exact-identifier boost, a one-hop import-graph boost from the top 5 hits, and paired tests and same-name docs pages (`docs/cli.rst` for `cli.py`) from the top 10. A pairing bonus never lifts a test or docs page above its source. There is an active-file boost and a query-coverage factor. Every hit carries reasons ("defines `x`", "path matches cli", "paired test for …", "imported by …"), the matched symbols, the best line range and the estimated read cost.
- `repoMap.ts`: a ranked outline (files plus top-level public symbols) by import centrality or task relevance, capped at the repo-map budget. It drops the lowest-ranked files and says how to see them.
- `mentions.ts`: parses `@path`, `@symbol`, `@Class.method` and explicit `@file:` and `@symbol:` mentions, ignoring email addresses. Gives fuzzy completion data for the editor. Resolves mentions to redacted content within a per-result cap and a total of 8,000 tokens; `@symbol` attaches the definition and lists its callers. Ambiguous or unknown mentions get suggestions, and a report states each attachment and its token cost.
- `test/retrieval-eval`: a vendored fixture project (`taskboard`, 40 files: a Python package, tests, docs and a TypeScript client), 20 labelled tasks, and a gate at recall@5 of 0.8 or better. With `SWAGE_FLASK_DIR` set, an optional Flask 3.1.3 run uses 11 labelled queries, including the exact Task A and Task B wording, with the blueprint G16 gates.

### Measured

Fixture (`npm test`, Node 26.8, Apple Silicon):

| Measure                            | Result                                |
| ---------------------------------- | ------------------------------------- |
| Mean recall@5 (gate 0.8)           | **0.883**, 16 of 20 tasks fully found |
| Mean token cost of the top 5 files | 868 tokens                            |
| Index build, cold (40 files)       | 27 ms                                 |
| Query time                         | mean 0.35 ms, max 2.5 ms              |

Misses on the fixture: `docs/cli.md` for the config-command task (rank 6 to 10), `auth.py` for "log in with an email address", `config.py` for the `LOG_FORMAT` task, and `app.py` for "JSON error for 405". These need phrase-level understanding that lexical retrieval does not have; tuning further on a fixture I wrote would overfit it.

Flask 3.1.3 at `22d92470` (`SWAGE_FLASK_DIR=~/Desktop/Hackthons/flask npm test`):

| Measure                                        | Result                                                          | Target                  |
| ---------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| Mean recall@10 over 11 queries                 | **1.000**                                                       | 0.8 (G16)               |
| Mean recall@5                                  | 0.970                                                           |                         |
| Task B files                                   | `cli.py` #1, `test_cli.py` #3, `docs/cli.rst` #6                | all three in the top 10 |
| Task A (`get_debug_flag`)                      | `helpers.py` #1                                                 |                         |
| Index build, cold (229 files, about 17k lines) | 221 to 239 ms                                                   | under 2 s (G15)         |
| Index rebuild, warm from cache                 | 14 ms (229 of 229 reused); cache 546 KB                         |                         |
| Query time                                     | mean 2.0 ms, max 4.3 ms                                         | under 300 ms            |
| tree-sitter init plus four grammars            | 15 ms                                                           |                         |
| Repo map                                       | 1,420 tokens, 56 of 229 files                                   | about 1,500             |
| `@src/flask/helpers.py @get_debug_flag`        | 4,070 tokens: file truncated at 3,996, symbol 74 with 9 callers | 8,000                   |

Flask's `git status` stayed clean after the measurements.

### Tested

- 60 context unit tests, plus the fixture evaluation (3 tests) and the optional Flask evaluation. The whole suite is green; lint and build are green.
- Coverage for `src/changeset`, `src/safety` and `src/context`: 98.5% statements, 93.86% branches, 99.29% functions, 99.62% lines. The threshold is 90%, enforced in CI.

### Open

- Indexing runs on the extension host thread. The blueprint wants a worker thread; Flask builds in about 0.2 s, so this is not urgent.
- The extension does not use the context engine yet. `find_relevant_code`, `repo_map`, `read_files` (with `ReadBudget`) and the hints block still need wiring into the MCP server, and the VS Code watcher needs an adapter to `WatcherLike`.
- The cache lives in `.swage/index` inside the workspace, as requested, and is hidden from git by `.swage/.gitignore`. Blueprint section 8 prefers globalStorage; `IndexCache` can be swapped with no other change.
- The blueprint also suggests boosting files with diagnostics; that is not done, because it needs VS Code. The active-file boost is supported.
- The Flask evaluation runs locally only, because CI has no Flask checkout. Add a CI step that clones the pinned commit if the evidence should be automatic.

## Phase 3: TrueForge integration (11 November 2026)

Real TrueForge 0.184.2 and SDK 0.184.1. Every API shape was verified against the repository, the OpenAPI spec, the SDK types or a live server; details and surprises are in `docs/SPIKES.md`.

### Built

- `trueforge/start.sh` and `start.ps1`: the pinned `npx @truefoundry/trueforge@0.184.2 --port`, `SQLITE_PATH` outside the repository (default `~/trueforge-data/trueforge.sqlite`, the user's existing database, so the configured models carry over), `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` and `HOST=127.0.0.1`. The script refuses a database inside the repository.
- `src/supervisor`: starts TrueForge on a free 127.0.0.1 port, waits for `GET /healthz`, restarts on the same port after a crash (1, 2, 4, 8, 16 s), stops with SIGTERM then SIGKILL on the process group, can reuse an already-running server, and redacts every log line. `shutdownInOrder` stops TrueForge before the MCP server (upstream issue 878).
- `src/client`: an SDK wrapper. Agents are upserted by exact name (refusing `tfg` and `trueforge`); MCP registration uses bearer header auth; sessions can be named or inline; turns are streamed with `createTurnStream` and the SDK's `mergeEventDelta`; approvals resume with `user.tool_approval`; cancel is supported. A typed UI event stream offers `turn_started`, `text`, `tool_start`, `tool_result`, `approval_required`, `done`, `cancelled` and `error`. Manifests are validated by the SDK's own `AgentSpec` schema, which rejects unknown keys.
- `trueforge/agents/main.agent.json` and `inline.agent.json`, exactly as in blueprint section 6, with the model filled from the active profile at runtime. `config/models.example.json` holds the profiles (Gemini, Groq, Ollama); `config/models.json` is the local, git-ignored copy that also adds llama.cpp.
- `npm run setup` (idempotent MCP registration and agent upsert), `npm run smoke`, and `npm run spike -- <script>` (esbuild-bundled TypeScript scripts).
- Spike scripts for S7, S9, S10 and the issue 878 retest, with a local fake OpenAI endpoint and a stub MCP server, so no spike sends anything to a real provider except S9's deliberate model calls.

### Measured (details in `docs/SPIKES.md`)

- Smoke: "say hello" through TrueForge to Gemini Flash, 2.3 s.
- S7: refused connection 22 ms and HTTP 401 21 ms, each as `turn.done` error; a hanging endpoint takes 64.7 s (20 s header timeout, 2 retries); unknown or private hosts are refused when the provider is saved.
- S10: pytest in a shadow copy imports the installed package unless `PYTHONPATH=<shadow>/src`; with it, Flask's `tests/test_cli.py` passes (58 tests, 0.13 s).
- Issue 878 retest: TrueForge 0.184.2 stayed up when a registered MCP server stopped, in both stateless and stateful modes.
- S9 first run: Gemini Flash 7 of 10 (2 quota 429s, 1 probe token cap); Groq 0 of 10 (404: the configured model is not available to the key); local models not measured because the user's TrueForge stopped during the first Ollama trial.

### Open

- **User action: Flask venv.** It has pytest 9.2.0, which cannot run Flask 3.1.3's tests (`monkeypatch.notset`); run `~/Desktop/Hackthons/flask/.venv/bin/pip install pytest==9.0.2`.
- **User action: Groq model.** Pick a Groq model this key can use in TrueForge Settings, Models, then update `config/models.json`.
- **S9 second run** (see `docs/SPIKES.md`): Groq still 404 with the re-saved key, so the model ID must change; Ollama `qwen2.5-coder:7b` 0/10 (cold-load header timeouts, then text replies without tool calls); llama.cpp not measured because `llama-server` had stopped. TrueForge survived the Ollama run but stopped soon after, cause unknown. Next: choose a Groq model the key can use, try a tool-capable local model (for example `qwen2.5:7b`), and re-test llama.cpp alone.
- Unit coverage of `supervisor.ts` is 85% (the real clock and process kill paths are exercised only by the spikes).

## Phase 4: Local MCP server and editor tools (11 November 2026)

`src/mcp`: Swage's MCP server with the nine tools of blueprint section 6. Pure Node with no `vscode` import.

### Built

- `server.ts`: official MCP SDK, Streamable HTTP in stateless mode (the mode the issue 878 retest validated), bound to 127.0.0.1 on a random port, with a random 32-byte bearer token compared in constant time. It returns 401 without the exact token and 403 for a Host header other than 127.0.0.1 or localhost (DNS rebinding); it serves only POST `/mcp`, with a 4 MB body limit.
- `tasks.ts` and `context.ts`: tasks keyed by Swage's task id hold the change set, the per-run read budget, an abort controller and the current TrueForge turn id. Starting a task cancels the previous one. `runTool` wraps every tool: it requires an active task, combines the task and request abort signals, times and logs each call (`tool <name> <ms> <outcome>`), turns errors into structured `{ error: { code, message, … } }` results, redacts every result, and discards a result whose task was cancelled or whose turn changed while it ran.
- Tools:
  1. `find_relevant_code`: BM25 hits with reasons and exact snippets.
  2. `repo_map`: ranked outline within the repo-map budget.
  3. `read_files`: up to 10 files, line ranges, path guard, staged overlay view, sha256 prefix, binary and size checks, did-you-mean suggestions, per-result and per-run budgets.
  4. `get_symbol`: definition, uses, paired tests, other definitions.
  5. `declare_context`: plan and files with reasons, path-guarded, UI event.
  6. `stage_edit`: edit, write or delete in the overlay only, with change-set error codes passed through and deleted-symbol warnings that include unchanged files importing a staged file.
  7. `run_tests`: allowlisted tests in a shadow copy.
  8. `run_command`: the command policy; denied commands never run, other commands need a one-time approval, and everything runs in a shadow copy.
  9. `submit_change_set`: marks the change set for review, applies nothing, idempotent.
- `shadow.ts`: temp copy of the workspace without ignored paths and symlinks, with the staged overlay applied; content-hash snapshots before and after report the files a command created, modified or deleted (discarded, never assumed reversible). The environment is scrubbed to an allowlist; `.venv` interpreters resolve against the real workspace; the shadow `src` comes first on `PYTHONPATH`; pytest runs with `-p no:cacheprovider`. There is no shell, output is capped and redacted, and the process tree is killed on timeout or cancel.
- File text is wrapped in `<<<FILE …>>>` markers labelled as repository data (rule 6).
- `trueforge/mcp/editor-tools.json`: the registration template (port and token filled at runtime) and the tool policy. Five hot tools are preloaded; `repo_map`, `get_symbol`, `run_tests` and `run_command` are deferred; `submit_change_set` and `run_command` require approval by name. A test keeps it in sync with the server and the agent manifests.

### Tested

- 370 tests pass (1 skipped: the Flask evaluation without `SWAGE_FLASK_DIR`); lint and build pass.
- `test/mcp`: the server, each tool, the shadow runner and an end-to-end test that drives all nine tools through the official MCP client over HTTP in one agent workflow. The workspace hash is unchanged afterwards, a planted secret never appears in any result, every tool logs its timing, and requests without the token (401) or with a foreign Host (403) are refused.
- Cancellation: a cancelled task aborts a running test command, its process tree is killed, and the late result is discarded; a result from a superseded turn is discarded.
- Coverage: all files 97.4% statements, 91.3% branches; `src/mcp` 95.7% and `src/mcp/tools` 98.8% statements.

Hot-path timings on the fixture (40 files): `find_relevant_code` 8 ms, `repo_map` under 1 ms, `read_files` 1 ms, `get_symbol` 13 ms, `declare_context` under 1 ms, `stage_edit` 2 ms, `submit_change_set` under 1 ms. `run_tests` adds the shadow copy and the command itself; both are logged on every call.

### Open

- Nothing is wired into the extension yet: `extension.ts` must start the supervisor and the MCP server, register `editor-tools` with the generated port and token (`npm run setup` logic), start a task for every run, record `run_command` approvals, and apply after review.
- One task at a time: inline edit and agent mode share the MCP server, so the UI must not run both at once (blueprint section 8 already requires that).
- JavaScript projects: `node_modules` is not copied into shadows, so JS test runners that need dependencies will fail there; consider a read-only symlink or `NODE_PATH`.
- Approved commands run in the shadow copy, not the real workspace, so a command such as `pip install` does not change the user's environment; the result says so.

## Phase 5: Agent panel and the end-to-end agent run (11 November 2026)

Blueprint sections 3 (F2, F3, F5, F14, F15), 4, 8 and 10.

### Built

- `test/fake-model`: an OpenAI-compatible chat-completions server on 127.0.0.1 that plays JSON scenarios (one per model id): SSE streaming, tool calls, first-token and chunk delays, a stall, HTTP 429 and 500, a dropped connection, a hang, and `errorTimes` for flaky steps. The step is chosen by the number of assistant messages in the request, so TrueForge's retries replay it. There are ten scenarios (three-file-edit, streaming-cancel, long-tests, approval, rate-limit, server-error, refused, hang, stall, flaky) and a demo workspace they edit. `npm run fake-model` serves it on port 8787 and registers it in TrueForge as the custom provider `swage-fake`; `config/models.test.json` and the demo workspace's settings use `swage-fake/three-file-edit`.
- `src/ui/protocol.ts`: a typed webview protocol, validated with zod in both directions; malformed messages are dropped.
- `src/ui/webview`: a Preact panel bundled by esbuild into `dist/webview.js` and `webview-style.css` (no CDN, strict CSP with a nonce, VS Code theme colours). It has a prompt box with `@file` and `@symbol` completion, streamed assistant text, live tool rows (name, argument summary, duration, result size), the declared plan with reasons, a context budget meter, approval cards with Approve and Deny, Stop (also Escape) and Retry. The UI state is a pure reducer with unit tests.
- `src/agent/context.ts`: the first message holds the request, @-mention content, a repo map ranked by this request's search hits, and a hints block, each within its budget; the cost of each part feeds the meter.
- `src/agent/run.ts`: starts a task, opens a TrueForge session on the agent, streams events into the panel, pauses on `tool.approval_required` with cards, records `run_command` approvals, and resumes with `user.tool_approval`. A run that ends with staged but unsubmitted edits says so.
- Cancellation (blueprint section 8):
  - The UI flips to "Cancelled. Workspace unchanged." at once.
  - `sessions.cancel` and our own tool abort run in parallel; the `run_tests` process tree is killed.
  - The stream is drained to `turn.done` instead of breaking out; a 15 s safety net covers a missing `turn.done`.
  - Late events are dropped by turn id, and the overlay is discarded.
  - A new turn in the same session that cancels ours (`cancelled-for-next-turn`) is reported.
- `src/agent/controller.ts` and `extension.ts`: the Swage activity-bar container and Agent view.
  - The runtime starts on the first request, so activation stays fast: the index (cache in global storage, never the workspace) with a file watcher, the MCP server, TrueForge through the supervisor or an existing server, and setup (MCP registration with a fresh token, the agent for the first profile).
  - `swage.openAgent` focuses the panel, `swage.stop` cancels, and `swage.running` drives Escape; `deactivate` stops TrueForge before the MCP server.
  - A "Run Swage on the demo workspace" launch configuration opens the demo.
- Verified in TrueForge's source: deferred tools are called through `call_tool { mcp_server, tool_name, input }` (see `docs/SPIKES.md`). Summaries and approvals unwrap `input`, and the scenarios call `run_tests` that way.

### Tested

- 404 tests pass (1 skipped: the Flask evaluation without `SWAGE_FLASK_DIR`); lint, build and the VS Code integration test (2 tests: commands registered, agent view contributed) pass.
- The fake model server is tested over HTTP: chunk format, tool calls, step choice, delays, stall, 429 with Retry-After, 500, dropped connection, hang, unknown model, flaky retry. Every scenario parses, and every `stage_edit` anchor matches its demo file exactly once.
- Scripted agent runs use a TrueForge stand-in that executes tool calls against the real MCP server over HTTP, with event shapes from `docs/SPIKES.md`:
  - a normal three-file edit (plan, eight tool rows, tests passing, approval, done);
  - approval allow and approval deny;
  - a model error shown as one line;
  - a `run_command` approval;
  - a session-creation failure;
  - Stop during context assembly.
- Cancellation tests:
  - during streaming (UI flips in under 50 ms, the stream drains, no text after Stop);
  - during a two-minute `run_tests` (drained in under 10 s, process tree killed, overlay discarded);
  - a stale event after cancel (dropped);
  - a new turn replacing ours.
  - **Every cancel test asserts the workspace is byte-identical.**
- Coverage: all files 97.0% statements, 90.5% branches; `src/agent` 91.0%, `src/ui` 100% statements.

### Open

- **Real TrueForge run (11 November 2026):** the user ran the F5 demo (`trueforge/start.sh`, `npm run fake-model`, "Run Swage on the demo workspace") against TrueForge 0.184.2 and reported that it works: the scripted run streams in the panel, approval works and Stop works. Not yet checked in detail: the exact `tool.response` text TrueForge sends for a denied call, and how `call_tool` deltas look in a live stream.
- The Approve card on `submit_change_set` currently approves the submission; the Review view (per-block accept and reject, apply, undo) is the next phase and will drive this decision.
- The panel's Retry starts a fresh run with the same request (a new session); resuming a stopped session is not offered.
- Reload safety (F11) and the session log export (F12) are not built.
- The webview bundle is 834 KB unminified (zod validates messages inside the webview too); the production build is minified.

## Phase 6: Review experience (11 November 2026)

Blueprint section 8, built on the Phase 2 change-set engine.

### Built

- `src/review/model.ts` and `session.ts`: a VS Code-free review session per task.
  - It handles per-block accept, reject and split, plus accept or reject per file and for everything.
  - The preview drops rejected blocks, so the diff shows exactly what Apply will write.
  - Stats per file: blocks, added and removed lines.
  - `rebase` re-stages a file from new disk content.
- Native diff: read-only `swage-base:` and `swage-staged:` documents opened with `vscode.diff`. The Review tree lists files with block counts and +/- lines, and each file has block rows under it.
- CodeLens per block shows "Block i/n · +a -r", Accept, Reject and Split (Split only when the block has more than one line on a side). Decided blocks show "Accepted | Reject instead" or "Rejected | Accept instead". Gutter and overview-ruler marks show each block's state.
- Commands are available as buttons and in the palette: Accept and Reject block, file and all; Apply; Discard. Accepting or rejecting refreshes the tree, lenses, decorations and diff live.
  - Swage contributes `diffEditor.codeLens: true` as a default, because VS Code turns lenses off in diff editors otherwise.
- Apply builds one atomic `WorkspaceEdit` from the accepted result after a hash check against disk (an unsaved open document counts as disk).
  - On conflict, a clear message offers "Re-stage from current files". Nothing is partially applied.
  - Pending blocks need a confirmation; they are not applied.
- Undo: `swage.undoLastChangeSet` restores checkpoints two levels deep.
  - History persists in global storage (`checkpoints-<hash>.json`, written atomically), so it survives a reload.
  - A notification with an Undo button follows every Apply.
- The agent's `submit_change_set` approval is driven by the review: Apply approves (the tool result lists accepted and not-applied block ids), Discard denies with a reason. The panel's Approve and Deny buttons map to Apply and Discard.
- Screenshots: `npm run screenshots` captures `docs/images/review-diff.png` and `review-decisions.png` from a test VS Code over the remote debugging port. They use only fake-model content and contain no secrets.

### Tested

- 416 unit tests pass (1 skipped: Flask evaluation); lint and build pass. Coverage is 96.9% statements and 90.1% branches; `src/review/vscode/*` is excluded from unit coverage because it needs VS Code, and the integration test covers it.
- New unit tests cover:
  - the preview model, with one and many blocks;
  - session decisions, split and rebase;
  - checkpoint save and load, including a simulated reload followed by two undos;
  - an atomic `writeAll` failure that leaves files unchanged;
  - the applied summary from `submit_change_set`.
- VS Code integration test (`@vscode/test-cli`, 3 passing) on a temp copy of the demo workspace runs a scripted fake-model task that edits three files.
  - It accepts the `app/cli.py` block, rejects the `docs/cli.md` block and leaves the test file pending.
  - Apply writes only `app/cli.py`, and the agent run finishes `done`.
  - Undo restores every file; a second Undo reports nothing to undo.

### Open

- Reload survival is tested at the storage layer (save, load in a fresh applier, undo twice), not by reloading a real window.
- The integration test applies with `confirmPending: false`; the modal pending-blocks confirmation and the conflict re-stage dialog are not covered by an automated test yet (the conflict and rebase logic itself is unit-tested).
- The screenshots use a narrow sidebar, so the Review tree's labels are cut off.
- Still open from Phase 5: reload safety for a running task (F11) and the session log export (F12).
