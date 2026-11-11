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
