# TrueForge Forge-a-thon: Project Blueprint

Nov 10, 2026 · @Tanay Patil

## 1. Project overview

We are building **Swage** (a swage is the smith's tool that shapes hot metal exactly, a fitting name for an editor that shapes diffs): a VS Code extension that is a thin, safe client of a TrueForge agent. The target is 90+ of 100 points by making five behaviours provable on screen inside a 4-minute video. The Round 1 deadline is 20 November 2026, 23:59 IST; registration closes 15 November.

**What the extension does**

- Inline edit: select code, press a key, type an instruction, review a per-hunk diff.
- Agent mode: one request makes a TrueForge agent find and edit three or more files unprompted.
- Context assembly: `@file` / `@symbol` mentions plus budgeted automatic retrieval, shown in a Context Receipt.
- Diff review and undo: every change is staged, reviewed hunk by hunk, applied atomically, and undoable.
- Streaming and cancellation: tokens stream; Stop is instant and leaves the workspace consistent.
- Resilience: when a model fails, retry or switch to a second configured model with no user action.

**Out of scope (do not spend time here)**

Tab completion, fill-in-the-middle, training or hosting a model, any hosted backend or database, accounts or authentication, Marketplace publishing.

**Guiding principles**

1. The agent loop runs only on TrueForge. The extension never calls a model provider, not even for embeddings.
2. The agent decides what to read and change; the extension supplies tools, budgets and safety.
3. Nothing touches disk until the user approves it, and every apply is undoable.
4. Behaviour must be identical on any model, so build for the weakest one the organisers might pick.
5. Everything is free and open source. No paid API is required to build, run or demo.

## 2. Gap register

Fifty gaps were found by stress-testing the design against TrueForge's documented behaviour, the rubric and real tools. P0 must be solved before the video is recorded; P1 before submission; P2 if time allows. Items marked (review) came from the earlier design review.

### Platform and integration

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G1 | The MCP server is unreachable from TrueForge, or callable by any local process | Bind 127.0.0.1 on a random port, require a bearer token, and let `Swage: Doctor` probe it end to end | P0 |
| G2 | TrueForge and its SDK are pre-1.0 and documented as experimental, so `@latest` can break a clean clone | Pin exact versions, commit the lockfile, put the pinned command in the README | P0 |
| G3 | TrueForge needs Node 22.14 or newer as a separate process, and npx differs per OS | Supervisor checks `node -v`, resolves `npx` or `npx.cmd`, picks a free port, kills the child on deactivate | P0 |
| G4 | Indexing or diffing on the extension-host thread freezes the editor | Run indexing and large diffs in a worker thread; keep all I/O async | P0 |
| G5 | MCP calls are stateless but the change set is stateful, and fallback switches sessions | Key the change set by task ID, not session ID; persist it to globalStorage | P0 |
| G6 | A window reload orphans the running stream | Persist session, turn and last sequence number; reconnect with `after_sequence_number` | P1 |

### Safety and correctness

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G7 | (review) Cancelling a command does not reverse its side effects | Run in a shadow copy by default; record a file manifest before real-tree runs; kill the whole process tree; report changes honestly | P0 |
| G8 | (review) `run_command` can do anything, including `rm -rf` | Split into `run_tests` (strict allowlist, scrubbed env) and `run_command` (annotated destructive, so TrueForge pauses for approval) | P0 |
| G9 | The user edits a file while the agent has it staged | Store base hash and document version at read; on submit detect drift, show the conflict, offer re-stage | P0 |
| G10 | Task B likely creates a file, but an edit-only model cannot | Change-set operations: edit, create, delete, rename; all reviewed and checkpointed | P0 |
| G11 | VS Code undo covers only open documents | Checkpoint store with hash verification is the source of truth; add `Undo last change set`; native Ctrl+Z still works | P0 |
| G12 | Path tricks (`../`, symlinks, `.git/`) escape the workspace | Resolve with realpath, enforce workspace containment, deny `.git/` writes | P0 |
| G13 | `.env` files are readable and repo text can carry injected instructions | Default ignore list plus `.swageignore`; redact secrets; label tool output as data; destructive actions still need approval | P1 |
| G14 | CRLF, BOM, binary and very large files corrupt or bloat edits | Preserve EOL and BOM, skip binaries, cap file size, apply through `WorkspaceEdit` | P1 |

### Context assembly

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G15 | The index goes stale or builds slowly | Incremental updates from a file watcher, persisted cache, honour `.gitignore`, target under 2 s for 17k lines | P1 |
| G16 | Nobody knows whether retrieval finds the right files | Hand-label 10 Flask queries including Task B; require recall@10 of 0.8 or better | P0 |
| G17 | A weak model ignores retrieval and reads files at random | Workflow in the system prompt; `stage_edit` refuses until `declare_context` was called; small labelled hints block | P0 |
| G18 | Deferred loading hides the tools the agent needs | Preload every tool Task B uses; leave only rare tools deferred | P0 |

### Models and resilience

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G19 | Weak models send bad arguments, wrong paths, or loop | Actionable validation errors, fuzzy path match, step cap, loop detector (same call three times) | P0 |
| G20 | Free-tier rate limits (429) hit mid-demo | One request at a time, honour `Retry-After`, small tool outputs, local model as last fallback | P1 |
| G21 | Not every local model supports tool calling | Day-1 capability probe; choose a tool-capable model; fenced-code fallback for inline edit | P0 |
| G22 | (review) A fixed 8 s watchdog kills healthy slow models | Layered timeouts per model profile: connect, first token, stall, total; hard errors fall back at once | P0 |
| G23 | (review) Fallback may not work when the organiser changes the primary | Profile list generates one agent per model; three explicit tests (see section 8) | P0 |

### Delivery

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G24 | Task B too slow for an uncut video | Latency budget, batched reads, parallel tool calls, pick the model on speed, 8 of 10 rehearsals must pass | P0 |
| G25 | Tests cannot import the staged code (editable installs point at the real source) | Detect the venv; set `PYTHONPATH` to the overlay; fallback is to run tests after apply | P0 |
| G26 | (review) Task A may produce one block, not two | Review by change block with split action; test on real diffs (1 to many blocks) | P0 |
| G27 | (review) The explorer subagent adds time and complexity | Single agent first; deferred loading covers B4; subagent only if rehearsals prove it helps | P2 |
| G28 | Setup fails on another machine | `Swage: Doctor`, a `setup` script, and CI on Windows, macOS and Linux | P1 |
| G29 | Write-up scorecard needs video timestamps | Record the video first, then fill the scorecard | P1 |
| G30 | Licence or attribution mistakes are an eligibility failure | MIT licence, NOTICE for any borrowed snippet, dependency licence scan in CI | P1 |

### Added by the 11 November audit (G31 to G50)

Twenty more gaps came from the line-by-line audit in section 16, the rubric matrix in section 17 and the official docs in section 15.

| ID | Gap | Fix | Pri |
| --- | --- | --- | --- |
| G31 | Cancellation is not part of the three fixed tasks, so A3 would have no video evidence | Add a 12-second cancel demo before the real Task A run | P0 |
| G32 | Per-hunk reject is never exercised by the fixed tasks | Block states are toggleable; show reject, revert, then accept each block | P0 |
| G33 | Accepting the Task C fallback diff would change files and break "git status clean" | In Task C, Reject all and then show a clean status | P0 |
| G34 | Doctor or model probes could call the model endpoint directly, an eligibility failure | Every probe is a TrueForge turn; no provider URL appears in the code | P0 |
| G35 | TrueForge blocks private addresses by default, so a localhost MCP server fails | Start with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`; Doctor checks it | P0 |
| G36 | TrueForge's SQLite database could land inside the repository | Set `SQLITE_PATH` outside the repo and run `npx` from another folder | P0 |
| G37 | A stopped MCP server can crash the TrueForge process (public report, v0.2.1) | Stop TrueForge before the MCP server; supervisor restarts it; retest on the pinned version; candidate upstream fix | P0 |
| G38 | Unlabelled MCP tools run without approval, so annotation-based gating fails open | Gate `submit_change_set` and `run_command` by name in the manifest | P0 |
| G39 | Ask-user questions and Generative UI are on by default and can pause or confuse a turn | Turn both off; still handle every pause type defensively | P0 |
| G40 | Dynamic subagents are on by default and add latency and variance | Turn off until rehearsals prove they help | P1 |
| G41 | "Plan a change" is in the statement but nothing shows a plan | `declare_context` carries ordered plan steps; the panel shows them | P1 |
| G42 | The statement's three named failures (lost file, unrequested rewrite, nonexistent symbol) are not addressed | Guardrails F13: pinned files, range lock, symbol and anchor checks, syntax check | P1 |
| G43 | The agent can hit its step limit or give up, leaving staged edits in limbo | Explicit stopped state with Review, Continue and Discard | P1 |
| G44 | The SDK's default timeout is 60 s and ends long turns early | Set `timeoutInSeconds` to 600 or more; resume with `subscribeToTurn` | P0 |
| G45 | Forking: Roo Code is archived, Continue is read-only, Cline is reorganising | Build from scratch; borrow only ideas | P1 |
| G46 | Another team's entry is public with a similar architecture; copying risks disqualifying every team involved | Do not read or reuse it; write every module yourselves | P0 |
| G47 | The verification command uses Unix syntax | Record in bash or WSL, or adapt it and say so in a caption | P2 |
| G48 | The write-up must fit eight headings in three pages | Word budget per heading (section 13) | P1 |
| G49 | A model that rejects extra parameters breaks a turn | Send only `temperature` and `max_tokens` in `model.params`; no `reasoning_effort` | P1 |
| G50 | A raw stack trace or provider message could reach the UI, which is the B3 zero anchor | Normalise every error to one short line; details go only to the log file | P0 |

## 3. Feature specification

Five capabilities are mandatory; the other features exist to make those five robust and provable. Every feature below is something a judge can see on screen.

### Mandatory capabilities

| # | Feature | Required behaviour | Rubric |
| --- | --- | --- | --- |
| F1 | Inline edit | Select code, press the keybinding, type a plain-language instruction. A one-tool TrueForge agent proposes the change, which renders in the editor as change blocks with Accept and Reject CodeLens above each block, plus Accept all and Reject all. | A1 (10) |
| F2 | Agent mode | A side panel takes one request and drives a TrueForge agent through search, read, stage, test and submit. It changes three or more files without the user naming any. The panel shows the tool timeline and a Stop button. | A2 (10) |
| F3 | Context assembly | `@file` and `@symbol` mentions with autocomplete, plus automatic retrieval by a budgeted `find_relevant_code` tool and a small hints block. A Context Receipt lists chosen files, the reason for each and tokens used against the budget. | B1 (15) |
| F4 | Diff review and undo | One Review view lists files and change blocks, opens native diffs, and accepts or rejects per block, per file or all at once. Apply is atomic and creates a checkpoint. `Undo last change set` restores hash-verified originals. | B2 (10) |
| F5 | Streaming and cancellation | Tokens appear as TrueForge streams them. Stop responds at once, aborts model and tools, discards staged edits and leaves the workspace unchanged. The editor never blocks. | A3 (10) |

### Supporting features

| # | Feature | Required behaviour | Rubric |
| --- | --- | --- | --- |
| F6 | Resilience | An ordered list of model profiles. Hard errors (401, connection refused) switch at once; retryable errors (429, 5xx, stall) retry with backoff, then switch. A toast names the switch. `git status` stays clean. | B3 (10) |
| F7 | TrueForge integration | The extension hosts a local MCP server for the editor tools. TrueForge's tool approval pauses `submit_change_set` and drives F4. Rarely used tools stay deferred. | B4 (10) |
| F8 | Swage: Doctor | One command checks Node version, TrueForge health, MCP reachability from TrueForge, model ping, git and the Python venv, and prints a fix for each failure. | C1, C2 |
| F9 | Model switcher | Quick-pick to change the primary model or add any OpenAI-compatible endpoint, for the live call with the organisers' model. | Fairness |
| F10 | Safety layer | Path containment, secret redaction, `.swageignore`, and the split between `run_tests` and approval-gated `run_command`. | A3, B2 |
| F11 | Reload safety | Session, turn and sequence number persist; after a reload the stream reconnects instead of restarting. | Robustness |
| F12 | Session log export | Writes a redacted log outside the repo for debugging and for the video's TrueForge session segment. | C1 |

### Features added by the audit

| # | Feature | Required behaviour | Rubric |
| --- | --- | --- | --- |
| F13 | Guardrails against the statement's three named failures | **Pinned context:** the active file and `@` mentions are always in the request. **Range lock:** an inline edit can change only the selection; blocks outside it are flagged in review. **Anchor and symbol checks:** `stage_edit` requires the old text to match exactly once and any named symbol to exist in the index, and answers with "did you mean". **Syntax check:** tree-sitter error nodes for any supported language, plus `python -m py_compile` for Python | A1, A2, B1 |
| F14 | Plan view | `declare_context` returns ordered plan steps and the files chosen with reasons; the panel shows them before edits begin | B1 |
| F15 | Stopped states | Paused for review, cancelled (with the reason TrueForge reports), error (one short line, no stack trace) and gave up or hit the step limit (Review, Continue or Discard the staged edits) | A2, A3, B3 |
| F16 | Inline diff rendering | The proposal is a virtual document opened in the native diff editor beside the selection in inline mode, with Accept, Reject and Split CodeLens above each change block; block states stay toggleable until apply. Multi-file work uses the Review view | A1, B2 |
| F17 | Open TrueForge session | A command that opens the TrueForge UI's Sessions page in the browser, used for the Task B session segment; confirm the exact URL on Day 1 | B4, C1 |
| F18 | Performance report | A command that prints activation time, Stop latency, time to first token, index build time and event-loop lag, as evidence for the "fast" claim | C2 |

If the model returns no tool call in inline mode, the extension parses a fenced code block from the reply into the same diff path, so a weak model still produces a reviewable change.

### Commands, keybindings and settings

| Command | Suggested key | Purpose |
| --- | --- | --- |
| `swage.inlineEdit` | Ctrl/Cmd+Alt+K | Instruction box for the current selection |
| `swage.openAgent` | Ctrl/Cmd+Alt+A | Open the agent panel |
| `swage.stop` | Esc (panel) or Ctrl/Cmd+Alt+. | Cancel the active run |
| `swage.reviewChanges` | Ctrl/Cmd+Alt+R | Open the Review view |
| `swage.undoLastChangeSet` | Ctrl/Cmd+Alt+Z | Restore the last applied change set |
| `swage.switchModel` | none | Pick or add a model profile |
| `swage.doctor` | none | Run the environment checks |

Settings: `swage.models` (ordered profiles with timeouts), `swage.budgets` (token budgets), `swage.ignore` (extra ignore globs), `swage.truefoundry.baseUrl` and `swage.autoStart`. API keys are never stored by the extension; they live in TrueForge's own configuration.

## 4. Architecture

&#91;embedded content: architecture · 2 zones, 9 boxes\]

The extension starts TrueForge, sends turns and renders events. The agent calls back into the extension's MCP server for every read, search, edit and command, and only TrueForge talks to the model.

### Process model

- **Extension host:** commands, UI, SDK client, resilience controller, MCP server (HTTP on 127.0.0.1) and the change set. Everything is asynchronous.
- **Index worker:** a worker thread so indexing and large diffs never block the editor.
- **TrueForge:** a child process started by the supervisor with the pinned `npx` command, on a free local port, stopped when the extension deactivates.
- **Shadow copy:** a temporary directory outside the repository where `run_tests` executes against the staged files.
- **Webview:** a Preact UI that only exchanges messages with the extension host; it never sees keys or the MCP token.

## 5. Tech stack (free and open source only)

Every required tool below is free and open source, so nothing needs a paid plan. Licences are stated from memory of each project; run a licence scan in CI (G30) before submitting and correct any row that differs.

### Runtime and extension

| Layer | Choice | Licence | Why |
| --- | --- | --- | --- |
| Editor | VS Code (or VSCodium for a fully open build) | MIT source | Required target of the competition |
| Language | TypeScript | Apache-2.0 | Same language as the TrueForge SDK |
| Runtime | Node.js 22.14 or newer | MIT | Required by TrueForge; also runs the supervisor |
| Bundler | esbuild | MIT | Fast, one config for extension and webview |
| Packaging | `@vscode/vsce` | MIT | Builds a `.vsix` for local install (no Marketplace publishing) |
| Agent harness | TrueForge (`@truefoundry/trueforge`) | MIT | Mandatory agent loop, run locally with npx |
| Harness client | `@truefoundry/trueforge-sdk` | MIT | Sessions, turns, streamed events |
| MCP server | `@modelcontextprotocol/sdk` with Streamable HTTP | MIT or Apache-2.0 | Exposes editor tools to TrueForge |
| Validation | Zod | MIT | Typed tool arguments and config |

### Editor features and context

| Layer | Choice | Licence | Why |
| --- | --- | --- | --- |
| Diffing | `diff` (jsdiff) | BSD-3-Clause | Change blocks, patches, three-way checks |
| Review UI | Native VS Code diff, CodeLens, decorations, TreeView | MIT API | No custom diff viewer to build |
| Webview UI | Preact with plain CSS using VS Code theme variables | MIT | Small bundle; the VS Code webview toolkit is deprecated, so avoid it |
| Search | `@vscode/ripgrep` | MIT | Fast text search honouring `.gitignore` |
| Symbols | `web-tree-sitter` with Python, TypeScript and JavaScript grammars | MIT | Definitions and imports without a language server |
| Ranking | MiniSearch or a small custom BM25 | MIT | Lexical scoring, no model calls |
| Process control | `tree-kill` or a custom kill-tree | MIT | Stops the whole process tree on cancel |
| Command parsing | `shell-quote` | MIT | Allowlist validation for `run_tests` |

### Models (free options)

| Role | Provider | Kind | Runs where | Cost | Notes |
| --- | --- | --- | --- | --- | --- |
| Primary | Gemini Flash (Google Gemini, a TrueForge catalog provider) | Hosted free tier | Google's servers | Free within limits | Fast, so it is the recording model; limits change, so verify before relying on them |
| Fallback 1 | Groq (custom OpenAI-compatible provider) | Hosted free tier | Groq's servers | Free within limits | Very fast; choose a tool-calling model with the S9 probe; this is the model Task C switches to |
| Fallback 2 | Local Ollama (MIT) | Open-weight model | Your laptop | Free | OpenAI-compatible endpoint at `http://127.0.0.1:11434/v1`; needs a tool-calling-capable model; 16 GB RAM is a sensible minimum |
| Fallback 3 (optional) | llama.cpp server (MIT) | OpenAI-compatible endpoint | Your laptop | Free | `llama-server` at `http://127.0.0.1:8080/v1`; start it with the tool-calling chat template enabled (`--jinja`, confirm on Day 1); swap it with Fallback 2 if its tool calls prove more reliable |

Gemini is added from TrueForge's catalog; Groq, Ollama and llama.cpp are added as custom OpenAI-compatible providers under Settings, Models. The extension never holds a key or a provider URL, because profiles name TrueForge models only. The two local endpoints must use `127.0.0.1`, and TrueForge must start with that address allowlisted. In Task C the primary (Gemini) gets an invalid key and the extension falls to Groq, which keeps the uncut segment short; the local models cover the case where both hosted tiers fail or the network is down. At the live call the organisers' model replaces the primary. Hosted free tiers are free but not open source, which the statement allows; check their terms, because free tiers may use prompts to improve products, so use them only on public code such as Flask.

### Quality, delivery and the target repository

| Layer | Choice | Licence |
| --- | --- | --- |
| Unit tests | Vitest | MIT |
| Extension tests | `@vscode/test-cli` and `@vscode/test-electron` | MIT |
| Lint and format | ESLint, Prettier | MIT |
| CI | GitHub Actions on a public repo | Free for public repos |
| Licence scan | `license-checker` or a maintained fork | BSD-3-Clause |
| Screen recording | OBS Studio | GPL-2.0 |
| Video editing | Kdenlive or Shotcut | GPL |
| Write-up PDF | LibreOffice, or Pandoc with Typst | MPL-2.0, GPL, Apache-2.0 |
| Video hosting | YouTube unlisted | Free |
| Pinned test repo | pallets/flask 3.1.3 with Python and pytest | BSD-3-Clause, PSF, MIT |
| Architecture diagram in README | Mermaid | MIT |

**Hardware guidance:** a laptop with 16 GB RAM runs the extension, TrueForge and a small local model together; a GPU is optional but makes a local model fast enough for the uncut demo. The plan already makes a hosted free tier the primary and keeps the local models as the last fallbacks, so a local model only needs to be good enough for emergencies and the live call.

## 6. MCP tool contract and execution policies

The extension hosts one local MCP server; TrueForge calls it as a remote MCP server with header auth. Keep the surface to nine tools, because weak models handle small tool sets better. TrueForge pauses by default only for tools the server labels write or destructive, and unlabelled tools run without asking, so the agent manifest lists the gated tools by name (see the manifest below).

| Tool | Purpose | Annotation | Policy |
| --- | --- | --- | --- |
| `find_relevant_code` | Budgeted hybrid search returning snippets, a score and a reason per hit | readOnly | No approval |
| `repo_map` | Ranked outline of files and symbols within a small budget | readOnly | No approval |
| `read_files` | Batched, line-ranged reads with a content hash per file | readOnly | No approval; paths contained; secrets redacted |
| `get_symbol` | Definition, references and paired tests for a symbol | readOnly | No approval |
| `declare_context` | Records the ordered plan and the files chosen with reasons; drives the plan view and the Context Receipt | readOnly | No approval; required before staging |
| `stage_edit` | Edit, create, delete or rename inside the in-memory change set | readOnly (touches only the overlay) | No disk write; checks base hash |
| `run_tests` | Runs an allowlisted test command in the shadow copy | readOnly | Allowlist, scrubbed env, timeout, output cap |
| `run_command` | Any other command | destructive | TrueForge pauses; the user sees the exact command |
| `submit_change_set` | Asks to apply the staged set | write | TrueForge pauses; the Review view opens; apply is atomic |

### Execution policy summary

| Operation | Policy |
| --- | --- |
| Search and read files | No approval |
| Stage edits in memory | No disk write |
| Run allowlisted tests | Restricted execution in a shadow copy |
| Arbitrary terminal commands | User approval every time; never `allow_session` |
| Apply accepted changes | Explicit review approval; never `allow_session` |

### Rules every tool follows

1. Authenticate with the bearer token on every request; reject anything else with 401.
2. Resolve every path with realpath, require it to stay inside the workspace, and refuse `.git/` writes.
3. Return structured, actionable errors (for example "path not found; did you mean `src/flask/cli.py`?") so a weak model can self-correct.
4. Cap every result at about 4k tokens and say how to narrow the query when truncated.
5. Finish quickly and honour an abort signal, because TrueForge cancel waits for running MCP calls.
6. Treat all returned file text as data and wrap it so repo content cannot act as instructions.
7. `submit_change_set` is idempotent per change-set ID; a second call returns the first result.

### Approval flow for review

1. The agent calls `submit_change_set`; TrueForge ends the turn paused with `tool.approval_required`.
2. The extension reads the pending call, opens the Review view for that change set, and shows the model's own summary.
3. The user accepts or rejects blocks. The extension keeps those decisions locally.
4. The extension creates a continuation turn containing only the approval item (user messages cannot be mixed with approvals). `allow` lets the call run; `deny` carries a reason.
5. On `allow`, the tool applies only accepted blocks atomically, writes the checkpoint, and returns a structured result listing accepted and rejected blocks so the agent can react.

To build the review, read the paused turn's `required_actions`, take each pending call's `source_event_id`, find that `model.message` in the event index, and parse the `submit_change_set` arguments (the change-set ID) from its tool call. Resume with one `user.tool_approval` item per pending call, carrying the same `threadId` and `toolCallId`, and never mix it with a user message.

### Agent manifest (field names from the official create-agent page)

```json
{
  "model": { "name": "<provider>/<model>", "params": { "temperature": 0, "max_tokens": 4096 } },
  "instructions": "Short workflow: plan, retrieve, declare, stage, test, submit. Done means code, test and docs are updated.",
  "mcp_servers": [
    {
      "name": "editor-tools",
      "enable_tools": ["@all"],
      "preload": false,
      "preload_tools": ["find_relevant_code", "read_files", "declare_context", "stage_edit", "submit_change_set"],
      "require_approval_for_tools": ["submit_change_set", "run_command"]
    }
  ],
  "config": {
    "sandbox": { "enabled": false },
    "generative_ui": { "enabled": false },
    "ask_user_questions": { "enabled": false },
    "dynamic_sub_agents": { "enabled": false },
    "context_management": {
      "compaction": { "enabled": true },
      "large_tool_response": { "enabled": false }
    },
    "iteration_limit": 30
  }
}
```

- **Gating:** `submit_change_set` and `run_command` are listed by name, so the review and the command approval do not depend on tool labels. Still set the annotations correctly for tidiness.
- **Deferred loading:** the five hot tools are preloaded. `run_tests`, `get_symbol`, `repo_map` and `run_command` stay deferred, so the session visibly shows the agent discovering them. Task B needs `run_tests`, which makes the discovery likely.
- **Evidence for B4:** each model message reports input tokens split by tool definitions, instructions, harness and messages. Record the tool-definition tokens with all tools preloaded and with this setting, and put the saving in the write-up.
- **Inline agent:** the same manifest with `enable_tools` limited to `declare_context` and `stage_edit`, `iteration_limit` 8, and the selection passed as the only editable range.
- **Fallback profiles:** identical manifests that differ only in `model.name`. Because a session can take an inline `spec`, fallback opens a new session with the other model.

## 7. Context engine

Retrieval is lexical and structural, with no model calls, so it is free, fast, deterministic and identical on every model. This is the strategy to state in the write-up, and it targets the 15-point B1 anchor: retrieval with a size budget, visibly at work in Task B.

### Pipeline

1. **Index (worker thread).** Walk the workspace honouring `.gitignore` and `.swageignore`. Parse files with tree-sitter into symbols (functions, classes, methods), imports and identifier tokens. Persist the index in globalStorage and update it from a file watcher.
2. **Explicit mentions.** `@file` adds the file; `@symbol` adds the definition and its immediate callers. These are the user's choices and are always included, within a cap.
3. **Automatic retrieval.** `find_relevant_code` scores candidates by BM25 over identifiers, paths and docstrings, boosts symbol-name matches, the active file, files with diagnostics and files linked by imports or references, and adds the paired test file for any source file. It returns the top results as snippets with a reason.
4. **Repo map.** A ranked outline (files and top symbols) of about 1.5k tokens, so the agent sees the shape of the repository before searching.
5. **Hints block.** The first message carries up to five labelled candidate files with reasons. They are hints; the agent still decides what to read.
6. **Declare.** The agent must call `declare_context` with a short ordered plan, the files and the reasons before `stage_edit` is accepted. That call feeds the Context Receipt.

### Budgets (starting values, tune on Flask)

| Item | Budget | Behaviour at the limit |
| --- | --- | --- |
| Repo map | about 1.5k tokens | Drop lowest-ranked files |
| Hints block | 5 files, about 1k tokens | Keep top five |
| One tool result | about 4k tokens | Truncate and say how to narrow the query |
| Reads per run | about 30k tokens in total | Refuse further full-file reads; allow ranged reads |
| Whole conversation | TrueForge compaction near 85% of the model's input limit | Automatic; lossy by design |

Token counts are estimated as characters divided by 4, which is crude but model-independent. Replace it with a real tokenizer only if tests show the estimate is badly off.

### Context Receipt

A panel (and a block at the end of the run) lists each file the agent chose, the reason (for example "defines `routes_command`", "paired test for `cli.py`", "mentioned by user"), its tokens, and a bar for tokens used against the budget. It is the on-screen proof for B1 in Task B.

### Retrieval evaluation (G16)

Hand-label 10 queries on Flask 3.1.3, including the Task B wording and a few others. For each, list the files that must be found. Run the retrieval and report recall@10 and time. Gate: recall@10 of 0.8 or better and a warm query under 300 ms. Include the result table in the write-up as evidence.

### Weak-model safeguards

- Batch reads so a task needs fewer round trips.
- Fuzzy path resolution and "did you mean" errors.
- A step cap and a loop detector that stops after the same call three times and tells the agent to change approach.
- Secret redaction and the default ignore list before any text leaves the extension.

## 8. Review, undo, cancellation and resilience

One principle runs through all four: the workspace changes only at a single, reviewed, atomic apply, so every failure before that point leaves the workspace untouched.

### Change set (the core data model)

A change set is keyed by a task ID, not a TrueForge session ID, and persisted in globalStorage outside the repository.

| Field | Meaning |
| --- | --- |
| `taskId` | Stable across fallback sessions and window reloads |
| `ops[]` | Edit, create, delete or rename; each with path, base hash and base document version |
| `blocks[]` | Change blocks computed per file with zero or one line of context; each has a state (pending, accepted, rejected) |
| `declaredContext` | Files and reasons from `declare_context` |
| `status` | staging, submitted, applied, discarded, undone |

### Review

- Blocks are runs of changed lines, not unified-diff hunks, so nearby edits such as a docstring and a return line can be reviewed separately. A split action handles a block that merges too much.
- The Review view is a TreeView of files and blocks. Selecting a file opens the native diff; CodeLens above each block offers Accept and Reject. Bulk actions apply per file or to all.
- Test the UI with real model output: one block, many blocks, whitespace-only changes, pure deletions, end-of-file additions, CRLF files and a file edited by the user mid-run. Do not assume a block count.
- Before apply, compare each file's current hash with its base hash. A mismatch shows a conflict and offers to re-stage; it never overwrites.

### Apply and undo

1. Write a checkpoint: original content and hash of every touched file, plus the list of created files.
2. Apply accepted blocks in one `WorkspaceEdit` (create, delete and rename included) and save the documents so tests see the files on disk.
3. Record the post-apply hashes.
4. `Undo last change set` restores originals only if the current hash equals the recorded post-apply hash; otherwise it reports which files changed since and asks before restoring them.
5. Native Ctrl+Z also works for open documents, but the checkpoint is the source of truth.

### Cancellation sequence

1. The UI flips to Cancelled immediately (optimistic) and stops rendering stream events for that turn.
2. The extension calls TrueForge cancel and, in parallel, aborts in-flight tool executions with an abort signal. Process trees are killed with SIGTERM then SIGKILL (taskkill on Windows).
3. Cancel is asynchronous, so a few late events may arrive; drop them by turn ID.
4. The change set is discarded, so nothing is half-applied.
5. For real-tree commands (approved `run_command`), compare the pre-run file manifest with the current state and tell the user exactly what changed. Cancelling a process never implies its side effects were reversed.
6. One session per concurrent activity: creating a new turn in a session cancels the active turn, so inline edit and the agent panel use separate sessions and the UI never starts a turn while one is running.

### Stopped, failed and gave-up states

A turn can end in more ways than "done". Show each plainly, and never show a stack trace or a raw provider message, because a stack trace is the zero anchor for B3. Details go only to the log file.

| The turn ends as | Meaning | What the user sees |
| --- | --- | --- |
| `done` with `required_actions` | Paused for the `submit_change_set` review or a `run_command` approval | The Review view opens, or the exact command is shown |
| `done` with no actions | The agent finished | A summary; if edits are staged but unsubmitted: "The agent finished without submitting" with Review and Discard |
| `cancelled`, `client-cancelled` | The user pressed Stop | "Cancelled. Workspace unchanged." |
| `cancelled`, `cancelled-for-next-turn` | A second turn started in the same session | A bug guard: never start a turn while one is running |
| `cancelled`, `server-execution-timeout` or `abandoned` | TrueForge stopped the run | "Stopped by TrueForge." with the staged edits and Review, Retry and Discard |
| `error` | A model or harness failure with a message | The classifier decides: retry, fallback, or one clear line |
| Step limit reached | The agent used its iteration limit without finishing; how this arrives is a Day-1 check | "The agent reached its step limit. N edits staged" with Review, Continue and Discard |

Streaming details: set the SDK `timeoutInSeconds` to 600 or more, because the default is 60 s. After Stop, let the stream end by itself instead of breaking out of the loop. If the connection drops, call `getTurn` and then `subscribeToTurn` with the last sequence number.

### Resilience

Timeouts are separate per model profile, so a slow local model is not mistaken for a failed one.

| Timer | Hosted profile | Local profile | Meaning |
| --- | --- | --- | --- |
| Connection | 10 s | 10 s | Endpoint unreachable; hard errors skip timers entirely |
| First token | 45 s | 120 s | No model event at all after the turn starts |
| Stall | 30 s | 60 s | No events after output began |
| Total | 10 min | 15 min | Hard ceiling per attempt |

Values are starting points; tune per model during rehearsal. For the Task C demo only, use a demo profile with a short first-token cap, in case the unreachable endpoint hangs without an error.

| Failure | Action |
| --- | --- |
| 401, 403, connection refused, model not found | Switch to the next profile at once, no retry |
| 429, 5xx, timeout, stall | Retry with backoff (1 s, 2 s, 4 s; honour `Retry-After`), then switch |
| Context overflow | Let TrueForge compact; do not switch |
| All profiles failed | Clear message naming each failure; workspace unchanged |

While waiting, show "Waiting for model (14 s)" with Cancel and Switch model buttons, so a slow model is visible but never mistaken for a dead one.

**Three fallback tests (G23).** (1) Both agent definitions are created and run on the pinned TrueForge version. (2) Break the primary and confirm the switch happens with no click. (3) Swap the primary to a different model and confirm the fallback still works. Each profile generates its own TrueForge agent definition, and the new session starts from the task plus the current staged diff. Ask the organisers whether a client-side fallback earns the full 10 points.

## 9. Repository structure, config files and setup

The repository must work from a clean clone, be public before the deadline, keep an open-source licence, and contain no keys. File names below are proposals; adjust the agent-definition format after the Day-1 spike confirms TrueForge's schema.

**Naming:** the `swage.` command prefix, the setting names and the file names use the project name Swage. A quick GitHub search on 11 Nov 2026 found no project with this name; it was not exhaustive, so repeat the check before the first commit (section 18).

### Proposed layout

```text
product-repo/
  LICENSE                       open-source licence (NOTICE for any borrowed snippet)
  README.md                     setup, "from scratch", models, demo steps
  package.json  pnpm-lock.yaml  pinned dependencies
  .gitignore                    *.sqlite, .env, models.local.*, .trueforge/
  config/
    models.example.yaml         model profiles, no keys
    forgeignore.example         default ignore patterns
  trueforge/
    agents/
      main.agent.json           agent-mode manifest (section 6)
      inline.agent.json         inline-edit manifest
    mcp/
      editor-tools.json         how the local MCP server is registered
    start.sh  start.ps1         sets SQLITE_PATH and OUTBOUND_URL_ALLOWED_HOSTS, pinned npx
  src/
    extension.ts                activation, commands, keybindings
    supervisor/                 start, health-check, restart, stop TrueForge
    client/                     SDK sessions, SSE, reconnect, event router
    resilience/                 profiles, timers, classifier, fallback
    mcp/                        server, auth, tools, schemas
    changeset/                  model, overlay, checkpoint, apply, undo
    review/                     blocks, CodeLens, TreeView, native diff
    context/                    index worker, ranking, budgets, receipt
    safety/                     path guard, redaction, run_tests allowlist
    guardrails/                 anchor and symbol checks, syntax check
    ui/                         Preact webview: panel, receipt, timeline
  test/
    unit/  integration/  retrieval-eval/  fake-model/
  scripts/
    setup.ts                    idempotent: upsert agents, register the MCP server
    doctor.ts                   same checks as Swage: Doctor
    break-primary.ts            for Task C
    restore-primary.ts
  docs/
    writeup.md  scorecard.md  demo-script.md
  .github/workflows/ci.yml      build, test, licence scan, secret scan, three OSes
```

### Where state lives

All runtime state (change sets, checkpoints, index cache, logs, shadow copies) lives in VS Code's globalStorage or the OS temp directory, never inside the repository being edited. This keeps `git status` clean for Task C.

### Example model configuration (no secrets)

```yaml
profiles:
  - name: primary                      # Gemini Flash, hosted free tier
    kind: hosted
    trueforgeModel: <google provider>/<gemini flash model>
    params: { temperature: 0, max_tokens: 4096 }
    timeouts: { connectMs: 10000, firstTokenMs: 45000, stallMs: 30000, totalMs: 600000 }
  - name: fallback-1                   # Groq, hosted free tier
    kind: hosted
    trueforgeModel: <groq provider>/<tool-calling model>
    params: { temperature: 0, max_tokens: 4096 }
    timeouts: { connectMs: 10000, firstTokenMs: 30000, stallMs: 30000, totalMs: 600000 }
  - name: fallback-2                   # local Ollama
    kind: local
    trueforgeModel: <ollama provider>/<tool-calling model>
    params: { temperature: 0, max_tokens: 4096 }
    timeouts: { connectMs: 10000, firstTokenMs: 120000, stallMs: 60000, totalMs: 900000 }
  - name: fallback-3                   # llama.cpp server, optional
    kind: local
    trueforgeModel: <llamacpp provider>/<model>
    params: { temperature: 0, max_tokens: 4096 }
    timeouts: { connectMs: 10000, firstTokenMs: 120000, stallMs: 60000, totalMs: 900000 }
# No keys and no provider URLs in this file; both live inside TrueForge.
# Custom providers (Settings, Models): Groq (its OpenAI-compatible base URL),
# Ollama http://127.0.0.1:11434/v1 and llama.cpp server http://127.0.0.1:8080/v1.
# Start TrueForge with OUTBOUND_URL_ALLOWED_HOSTS including 127.0.0.1 for the local ones.
```

### Setup steps (README skeleton)

1. Install Node 22.14 or newer, Git, Python 3 and VS Code, and check `node -v`.
2. Clone the repository and run `pnpm install`.
3. Start TrueForge from a folder outside any repository, using the start script. It runs the pinned `npx @truefoundry/trueforge@<version>` with `SQLITE_PATH` and `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` set. The default address is `http://localhost:8790`.
4. In TrueForge, open Settings, Models and add the providers: Google Gemini from the catalog (primary), Groq as a custom OpenAI-compatible provider (fallback 1), Ollama as a custom provider at `http://127.0.0.1:11434/v1` (fallback 2), and optionally the llama.cpp server at `http://127.0.0.1:8080/v1` (fallback 3). Keys stay inside TrueForge.
5. Run `pnpm setup`. It registers the MCP server `editor-tools` and upserts the agents from `trueforge/agents/*.json` with `agents.create` or `agents.update`.
6. Press F5 to launch the extension host, or install the built `.vsix`.
7. Clone `pallets/flask`, check out tag 3.1.3 (commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`), create a virtual environment with Flask and pytest installed, and open the folder.
8. Run `Swage: Doctor`; every check must be green before recording.

## 10. Task runbooks and the 4-minute demo

The video must show Tasks A, B and C in that order, each followed by its on-screen verification, with the TrueForge session shown briefly during Task B. Do not cut between giving an instruction and the diff appearing, so each agent run must be fast enough to sit inside the budget below.

### Run order and time budget

| Segment | Time | What the screen shows | Proof |
| --- | --- | --- | --- |
| Title card | 0:00 to 0:04 | Caption "Flask 3.1.3, TrueForge local mode"; Doctor green | None |
| A0 Cancel demo | 0:04 to 0:16 | Select `get_debug_flag`, press the key, type the exact instruction; tokens stream in the progress widget; press Stop; "Cancelled. Workspace unchanged."; `git status` clean | A3 streaming and cancellation |
| A Inline edit | 0:16 to 1:02 | Same instruction again; the diff appears with no cut; reject block 1, revert it, then accept each block separately; run `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` | A1 per-hunk control; output `False` |
| B Agent mode | 1:02 to 2:47 | Agent panel with the exact instruction and no file named; the plan and Context Receipt appear (hold about 5 s); staged files; tests run; Review view; accept; TrueForge Sessions page for about 15 s showing turns, tool calls, the approval pause and the deferred-tool discovery | A2, B1, B4 |
| B verification | inside B, about 25 s | `pytest tests/test_cli.py -q` passes; `flask --help` lists `config`; the new command against a small app prints masked JSON; `git diff --stat` shows three or more files | Task B checks |
| Undo | 2:47 to 2:59 | `Undo last change set` twice; `git status` clean | B2 undo; clean baseline for Task C |
| C Resilience | 2:59 to 3:41 | The break-primary script gives the primary an invalid key; repeat the Task A instruction; keep typing in another file to show the editor is responsive; toast "Primary model failed (401); switched to the fallback"; the diff appears; Reject all; `git status` clean | B3 |
| Outro | 3:41 to 3:45 | A card listing each criterion and its timestamp | C1 |

The exact instructions are fixed by the organisers and must be typed as given; rehearse them verbatim.

**Notes on the script.** The cancelled first attempt in A0 and the Reject all in Task C are deliberate: the fixed tasks never show cancellation, per-hunk rejection or a clean workspace after fallback, and the rubric needs all three on screen. The no-cut rule applies to the successful runs in A, B and C. The statement's verification command uses Unix syntax, so record in bash or WSL, or adapt it for PowerShell and say so in a caption. Add short captions naming each task and its verification so a judge comparing many videos can follow, record at 1080p, and use a large editor font. The 3:45 total leaves 15 s of margin under the 4-minute limit.

### Latency budget (uncut segments)

| Segment | Instruction to diff, target |
| --- | --- |
| Task A | 15 s or less |
| Task B | 70 s or less |
| Task C | 30 s or less, including the fallback switch |

If the chosen model cannot meet these, pick a faster model for the recording; the rubric scores behaviour, not model quality. Ask the organisers in the Doubt portal whether speeding up playback counts as cutting.

### Task B: what a good run looks like

The likely files are `src/flask/cli.py` (the new command), `tests/test_cli.py` (a test), a docs page listing built-in commands, and possibly the changelog. Confirm against the 3.1.3 checkout; the agent must find them itself.

Watch for these details in the result:

- Config values that are not JSON-serialisable (for example time deltas) need a safe fallback when dumping.
- Masking applies to any key containing SECRET, PASSWORD, TOKEN or KEY, with a clear rule on letter case; the test should assert it.
- The command appears in `flask --help` and is documented next to the other built-in commands.

### Pre-recording checklist

- [ ] `Swage: Doctor` is fully green on the recording machine.
- [ ] Flask is at tag 3.1.3 with a clean `git status`; venv has Flask and pytest.
- [ ] The local model is warmed up so the first request is not a cold load.
- [ ] The fallback model works; the break-primary and restore-primary scripts are tested.
- [ ] Notifications are off; font and terminal are large enough to read in 1080p.
- [ ] The TrueForge session page is open in a tab, ready to show.
- [ ] Ten rehearsal runs of Task B were done; at least eight passed.
- [ ] The primary model is changed once, to prove the fallback still works (G23).
- [ ] Record several takes; keep the best one that is complete and uncut where required.
- [ ] Timestamps are written down before the scorecard is filled.

### Added after the audit

- [ ] The cancel demo, the per-hunk toggle, the double undo and the Task C Reject all are rehearsed.
- [ ] `git status` is clean before Task A, after the cancel demo, after Undo and after Task C.
- [ ] The TrueForge Sessions page is open in a tab and shows the Task B run.
- [ ] TrueForge was started from outside the repository with `SQLITE_PATH` set.
- [ ] No API key is visible on screen; Settings pages are closed or blurred.
- [ ] The final cut is under 4:00 and has captions.

## 11. Testing and QA plan

The most valuable test tool is a scripted fake model: a small OpenAI-compatible server that replays chosen tool calls and failures. It makes Task B, Task C and cancellation tests deterministic, free and fast, and it needs no real model or key.

### Test layers

| Layer | What is tested | Tool |
| --- | --- | --- |
| Unit | Path guard (including `../` and symlinks), redaction, `run_tests` allowlist against shell metacharacters, block computation, checkpoint and undo hashing, error classifier, timers with fake clocks, budget truncation | Vitest |
| Property | Applying any subset of accepted blocks gives the expected file; apply then undo returns the original bytes | Vitest with generated diffs |
| Integration | MCP server against a mock TrueForge client; approval pause and continuation; fallback chain against the fake model returning 401, 429, 503, a hang and a slow stream | Vitest plus the fake model |
| Extension host | CodeLens accept and reject, `WorkspaceEdit` apply, native Ctrl+Z, Review TreeView | `@vscode/test-cli` |
| Chaos | Kill TrueForge mid-run; reload the window mid-run; edit a staged file by hand; cancel at 100 random moments and check the workspace each time | Scripted harness |
| Retrieval | 10 labelled Flask queries; recall@10 and latency | Script in `test/retrieval-eval` |
| End to end | Tasks A, B and C on Flask 3.1.3, first with the fake model, then with each real model | Scripted run plus a manual check |
| Cross-platform | Build, tests and a smoke run on Windows, macOS and Linux | GitHub Actions |
| Clean clone | Follow the README on a fresh machine or VM with no prior setup | Manual, a teammate who did not write it |

### Acceptance gates tied to the rubric

| Rubric item | Gate before recording |
| --- | --- |
| A1 Inline edit | Diff appears with per-block accept and reject on 10 different real diffs |
| A2 Agent mode | Task B touches three or more files in at least 8 of 10 runs, none named |
| A3 Cancellation | 100 random cancels leave `git status` clean and no staged residue; Stop responds in under 1 s |
| B1 Context | Recall@10 of 0.8 or better; Receipt shows files, reasons and budget in Task B |
| B2 Diff safety | Apply then undo restores bytes exactly; a user edit after apply blocks a silent revert |
| B3 Resilience | Invalid key and unreachable endpoint both reach a fallback or a clear error; no hang; no changed files |
| B4 Integration | Session page shows MCP tool calls and the approval pause; deferred loading explained with measured tokens saved |
| C1 Video | Total length under 4:00; every verification step legible |
| C2 Write-up | Eight headings in order, at most 3 pages, scorecard timestamps match the video |

### Performance evidence for the "fast" claim

The statement asks for a safe and fast editor experience, so measure it and report the numbers in the write-up.

| Measure | Target | How |
| --- | --- | --- |
| Extension activation, excluding the TrueForge start | Under 300 ms | Timer around `activate` |
| Stop click to UI showing Cancelled | Under 200 ms | Timestamp at click and at state change |
| Stop click to TrueForge's terminal event | Under 2 s | Log the cancel call and `turn.done` |
| Time to first streamed token shown | Recorded per model | Log delta arrival |
| Index build for Flask (about 17,000 lines) | Under 2 s | Worker timing |
| Warm retrieval query | Under 300 ms | Worker timing |
| Extension-host event-loop lag during indexing | Under 50 ms | Timer drift sampling |
| Task A, instruction to diff | 15 s or less | Stopwatch on the recording model |

### Model matrix

Run Tasks A and B ten times on each candidate model and record success rate, wall-clock time and tokens. Pick the recording model on speed and reliability. Keep all four configured models (Gemini Flash, Groq, Ollama and llama.cpp) in the final matrix, so the "works on any model" claim has evidence in the write-up.

## 12. Timeline and team roles

&#91;embedded content: plan by date · 10 rows, 3 milestones\]

The Day-1 spikes come first because their answers can change the architecture. Recording starts on 18 November, which leaves a day of slack before the 19 November target and the 20 November deadline.

### Daily gates

- [ ] 12 Nov: spikes S1 to S10 answered; TrueForge, the MCP server and the fake model are talking.
- [ ] 14 Nov: Task A works end to end with the fake model.
- [ ] 15 Nov: registration confirmed (it closes that day).
- [ ] 17 Nov: Tasks B and C work with a real model.
- [ ] 18 Nov: eight of ten rehearsal runs pass; recording starts.
- [ ] 19 Nov: video, PDF and repository links submitted and checked in a private window.

### Team roles (up to five members)

| Role | Owns | Main deliverables |
| --- | --- | --- |
| Platform lead | TrueForge integration | Supervisor, SDK client and event router, agent definitions, MCP registration, Doctor command |
| Editor lead | Editor experience | Inline edit, agent panel, Review view, CodeLens, undo command |
| Context lead | Retrieval | Index worker, ranking, budgets, Context Receipt, retrieval evaluation |
| Safety lead | Change set and resilience | Overlay, checkpoints, apply and undo, cancellation, `run_tests` allowlist, fallback controller, fake model server |
| Delivery lead | Proof and packaging | Tests and CI, demo script, video, write-up, README, social posts |

With fewer than five people, merge Context into Editor and Delivery into Safety. Every member must still be able to explain any core module in the live call.

## 13. Submission checklist

Three artefacts are mandatory and are submitted as public links through the Techfest Competition Portal before 20 November 2026, 23:59 IST. Links that are not public at the deadline are not scored and access will not be requested. Aim to submit on 19 November.

### Eligibility gate (pass or fail)

- [ ] The agent loop runs on TrueForge in local mode (npx); the extension is a client creating sessions and turns.
- [ ] Read, search, propose-write and run-command are exposed as MCP tools; the agent decides what to read and change.
- [ ] Models are configured inside TrueForge; the extension makes no direct model or embedding calls (search the code for provider URLs and API clients).
- [ ] The video shows the TrueForge session for Task B (turns and tool calls).
- [ ] The agent definitions used are committed to the repository.

### Repository

- [ ] Public before the deadline, with an open-source LICENSE and NOTICE for any borrowed code.
- [ ] README with setup that works from a clean clone, including how to start TrueForge locally and load the agent definitions.
- [ ] Declared starting point: "from scratch" (or the upstream URL and exact commit if any code is forked).
- [ ] Example model configuration file; no API keys or secrets anywhere in history (run a secret scanner such as gitleaks before pushing).
- [ ] CI is green on three operating systems.

### Demo video

- [ ] Under 4 minutes; editor visible; Tasks A, B, C in order, each followed by its on-screen verification.
- [ ] No cut between giving an instruction and the diff appearing.
- [ ] Public link (YouTube unlisted, or Drive with "anyone with the link can view"); open it in a private window to confirm.

### Write-up (PDF, 1 to 3 pages, eight headings in order)

| # | Heading | Content to carry over from this blueprint |
| --- | --- | --- |
| 1 | Team | Members, college or employer, GitHub handles |
| 2 | Starting point | "From scratch", with the libraries used |
| 3 | Architecture on TrueForge | Section 4 diagram; MCP tools (section 6); harness features used and why (deferred loading, approval, compaction, subagent only if kept) |
| 4 | How context is selected | Section 7 strategy, budgets and the retrieval evaluation table |
| 5 | Model setup | Models used, where they ran, approximate cost (free), how to switch with `swage.switchModel` |
| 6 | Scorecard | One row per criterion with a video timestamp and a one-line claim (A1, A2, A3, B1, B2, B3, B4, C1, C2) |
| 7 | Tools used | Every AI coding assistant and library used; this costs no points |
| 8 | Known limitations | Honest list plus what another month would add |

Write the scorecard last, from the finished video's real timestamps. Keep every claim true; the scorecard is itself scored for accuracy.

**Word budget for three pages** (about 980 words plus the diagram and two tables):

| Heading | Words | Carry over from this blueprint |
| --- | --- | --- |
| 1. Team | 40 | Members, college or employer, GitHub handles |
| 2. Starting point | 30 | "From scratch" and the libraries used |
| 3. Architecture on TrueForge | 250 plus the diagram | Thin client, MCP tools, approval gated by name, manifest settings, harness features used and why |
| 4. How context is selected | 200 plus the evaluation table | Lexical, symbol and import retrieval, budgets, Receipt |
| 5. Model setup | 120 | Models, where they ran, cost, how to switch |
| 6. Scorecard | Nine rows, about 150 | Criterion, video timestamp, one-line claim |
| 7. Tools used | 40 | AI assistants and libraries |
| 8. Known limitations | 150 | An honest list and what another month would add |

Name the trade-offs explicitly, because C2 rewards them: lexical retrieval over embeddings, an in-memory overlay over direct writes, client-side fallback over a native one, approval gated by name, and no sandbox.

### Optional social media contest

Post the demo on LinkedIn, X or YouTube with the hashtags #TrueForge, #Forgeathon and #YourTeamName. One link per platform counts, posts must be published between 15 October and 18 December 2026, and links are submitted through the form TrueFoundry shares by 18 December. It is scored separately from the technical score.

### Added after the audit

- [ ] Star the TrueForge repository and join its Discord; the statement asks for this before any extension code.
- [ ] Host the write-up PDF at a public link (the repository's docs folder, or a shared drive set to anyone with the link) and open it in a private window.
- [ ] Put the timestamp list in the video description, matching the scorecard.
- [ ] Confirm the pinned TrueForge version still passes Doctor on submission day.
- [ ] Run the secret scan over the whole git history, not only the last commit.
- [ ] Post on at least one platform with the three hashtags and keep the link for the 18 December form.

## 14. Risks, Day-1 spikes and questions for the organisers

Several design decisions rest on TrueForge behaviour that could not be confirmed from the public pages available while researching this blueprint. Resolve these on Day 1, before writing feature code, because a failed spike changes the architecture.

**Update, 11 November:** the official docs settled S1 to S6 and S8 (section 15). Still open are S7 (the error shape for a bad key or unreachable endpoint), S9 (a tool-calling probe of candidate models) and S10 (`pytest` in the shadow copy). Where section 15 and the table below differ, section 15 wins.

### Day-1 spikes

| # | Question | Pass criterion | If it fails |
| --- | --- | --- | --- |
| S1 | How is a localhost HTTP MCP server registered in local mode (catalog file or settings API), with header auth? | TrueForge lists the extension's tools and can call one | Ask on the TrueForge Discord; ask the Doubt portal before using client-side tools as a substitute |
| S2 | Do tool annotations (read-only, write, destructive) decide which calls pause for approval? | `submit_change_set` pauses; read-only tools do not | Pause through an explicit approval policy or a client-side response tool |
| S3 | Can named tools be preloaded while the rest stay deferred? | Hot tools appear without discovery calls | Preload the whole server; measure the token cost |
| S4 | What is the agent-definition format, and can two agents bind to two models (one OpenAI-compatible endpoint)? | Both agents run a turn | Create agents through the HTTP API instead of files |
| S5 | What are the real event shapes for text deltas, errors and `turn.done` reasons? | Saved sample streams become test fixtures | Adapt the fake model and event router to what is observed |
| S6 | How does cancel behave: endpoint, timing, late events? | Stream closes with a terminal event within a second or two | Close the stream client-side and ignore stale events |
| S7 | What do an unreachable endpoint and a 401 look like on the wire, and how long until the error? | An error event arrives within the connection timeout | Use the demo profile's short first-token cap |
| S8 | Do subagents work without the optional sandbox? | A subagent turn completes | Drop the subagent; rely on deferred loading for B4 |
| S9 | Which candidate models call tools reliably? | At least 8 of 10 valid tool calls on a probe script | Use the structured fallback for inline edit; choose another model |
| S10 | Can `pytest` in the shadow copy import the staged code? | Tests see the staged `cli.py` | Run tests after apply, with the checkpoint as the safety net |

### Risks

| Risk | Mitigation |
| --- | --- |
| TrueForge changes an API mid-contest | Pin exact versions; keep the event router in one module; record sample streams |
| Task B is slow or flaky | Latency budget, batched reads, a faster model for recording, 8 of 10 rehearsal gate |
| Only 10 days to the deadline | Follow the cut order below; protect the core path first |
| The local model is too weak or too slow | Hosted free tier as primary, local as last fallback |
| Free-tier rate limits during recording | One request at a time; record inside the quota; keep the fake-model rehearsal for everything else |
| A teammate cannot explain a module in the live call | Every member reads the core modules; each owns one and writes a 5-line explanation |
| Clean-clone setup fails for a judge | Doctor command, setup script, CI on three operating systems, a teammate runs the README cold |

### Scope cut order if time runs short

1. Explorer subagent (already optional).
2. Session log export (F12).
3. Reload safety (F11).
4. Rename operations in change sets.
5. Tree-sitter, replaced by regex symbol extraction.
6. UI polish beyond the Receipt and Review view.

Never cut: atomic apply with undo, safe cancellation, automatic fallback, the Context Receipt, and the Doctor command.

### Questions for the Doubt portal

Queries sent by email are not answered; use the portal's Doubt section, and the TrueForge Discord for harness questions.

1. Does a client-side fallback to a second TrueForge agent earn the full 10 points for B3?
2. Does speeding up playback count as cutting between the instruction and the diff?
3. Is a lexical retrieval index acceptable, and is a local embedding model allowed, given the no-direct-provider rule?
4. May the README pin a specific TrueForge version instead of `@latest`?
5. If a local MCP server cannot be registered in local mode, are client-side tools acceptable?

## 15. What the official TrueForge docs settled

On 11 November the create-agent, use-agent, initial-setup and key-features pages were read in full, along with a public bug report. They settled seven of the ten Day-1 spikes in section 14, corrected one design decision (approval gating), and showed several defaults that must be overridden. Still open: S7, S9 and S10.

### Spike results

| # | What the docs say | Effect on the design |
| --- | --- | --- |
| S1 | A localhost MCP server works only if TrueForge starts with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`. A [public bug report](https://github.com/truefoundry/trueforge/issues/878) registers one with `PUT /api/v1/settings/mcp-servers` over streamable HTTP and lists its tools with `GET /api/v1/mcp-servers/{name}/tools`. | The supervisor sets the variable, the setup script registers the server, and Doctor checks that TrueForge can reach it. A community starter reports the same rule for local model endpoints, so use `127.0.0.1` in the Ollama base URL and confirm on Day 1. |
| S2 | Approval follows the labels an MCP server puts on its tools. `@write` and `@destructive` do not match unlabelled tools, which run without asking. `require_approval_for_tools` accepts `@all`, `@write`, `@destructive` or literal tool names ([create-agent](https://trueforge.dev/create-agent/overview)). | Gate `submit_change_set` and `run_command` by name in the manifest. This corrects section 6, which said the annotations decide. |
| S3 | `preload` defaults to `false`; `preload_tools` loads named tools eagerly while the rest stay deferred. | Preload the five hot tools and defer `run_tests`, `get_symbol`, `repo_map` and `run_command`, so deferred loading is visible in the session. |
| S4 | An agent is a manifest: `model` (`provider/model` plus params), `instructions`, `mcp_servers[]`, `skills` and `config`. `agents.create` (`POST /api/v1/agents`) and `agents.update` (`PUT /api/v1/agents/{id}`) manage named agents; names are unique and immutable. A session can also take an inline `spec`. | Commit manifests as JSON and upsert them from the setup script. Fallback can open a new session with a different model name. Avoid the agent names `tfg` and `trueforge`. |
| S5 | Events are `turn.created`, `model.message` with `model.message.delta`, `tool.response`, `tool.approval_required`, `tool.response_required`, `thread.created`, `thread.done`, `mcp.initialize`, `mcp.auth_required`, `sandbox.created` and `turn.done`. `turn.done` ends `done`, `cancelled` or `error`; a paused turn is `done` with `required_actions`. Each model message reports token usage split into harness, skills, instructions, tool definitions and messages ([use-agent](https://trueforge.dev/api/use-agent)). | Build the event router from these types. Use the tool-definition token count as the evidence for deferred loading. Treat `done` with required actions as paused, not finished. |
| S6 | `sessions.cancel` aborts the in-flight model request, waits for running MCP calls, is idempotent, and the stream ends itself after a terminal `turn.done` (do not break out of the loop). A new turn in a session cancels the running one. `subscribeToTurn` resumes after a sequence number. | As designed in section 8: one session per activity, abort our own tool executions on Stop, resume after a reload. |
| S7 | Not documented. A turn that ends `error` carries a `message`, so a bad key or unreachable endpoint most likely arrives as `turn.done` with `error`. | Still a Day-1 test: record the exact message for a 401, a refused connection and a silently dropped address, then classify by text. |
| S8 | Subagents are on by default, share the MCP tools, cannot ask the user questions and cannot nest. The sandbox is required for skills and Code Mode, and large-result offloading writes to a sandbox file ([key-features](https://trueforge.dev/key-features/overview)). | Subagents do not need the sandbox. Keep them off until a rehearsal proves they help. With the sandbox off, our own 4k result cap does the size control. |
| S9 | Not a docs question: which candidate models call tools reliably. | Probe through a TrueForge turn, never a direct call. |
| S10 | Not a docs question: whether `pytest` in the shadow copy imports the staged code. | Test on Day 3 (G25). |

### Defaults to override

| Setting | Documented default | Our value | Why |
| --- | --- | --- | --- |
| `config.sandbox.enabled` | off | off | Optional per the statement; skills and Code Mode are unused |
| `config.generative_ui.enabled` | on | off | Our UI renders no OpenUI blocks; shorter system prompt |
| `config.ask_user_questions.enabled` | on | off | A question pauses the turn and would hang an unattended run; still handle `tool.response_required` defensively |
| `config.dynamic_sub_agents.enabled` | on | off, then test | Adds latency and variance |
| `config.iteration_limit` | 512 in the API table, 100 in the UI text | 30 (agent), 8 (inline) | The docs disagree on the default, so set it explicitly |
| `config.context_management.compaction` | on, at 80% of model context or 50,000 input tokens | on, default trigger | Backstop for small local contexts; visible only if it fires |
| `config.context_management.large_tool_response` | on (writes to a sandbox file) | off | Needs the sandbox |
| `mcp_servers[].preload` | false | false plus `preload_tools` | Deferred-loading evidence |
| `model.params` | forwarded to the provider as-is | `temperature` and `max_tokens` only | Some endpoints reject extra keys; no `reasoning_effort` |
| SDK `timeoutInSeconds` | 60 | 600 or more | Long streamed turns |
| TrueForge base URL | `http://localhost:8790` | same | The documented default |

### Behaviours to design around

- **A stopped MCP server can crash TrueForge.** The bug report (v0.2.1, standalone) shows the whole process dying when a registered MCP server goes away. Our server lives in the extension, so a window reload or crash could trigger it. Stop TrueForge before the MCP server on shutdown, let the supervisor restart TrueForge (registrations, agents and sessions persist in SQLite), and retest on the pinned version. The status of the issue was not visible, so check it.
- **Local mode has no login.** Settings are open to anyone who can reach the server, so keep it on localhost and keep our MCP server behind its own bearer token.
- **Approvals and answers are new turns.** They cannot be mixed with a user message in the same input list.
- **Cancel waits for running MCP calls.** Keep tools short and abort our own work on Stop.
- **Store the database outside the repository.** `SQLITE_PATH` sets it, and `git status` must stay clean in Task C.

### Pinned repository facts

| Fact | Detail |
| --- | --- |
| Commit | Tag 3.1.3 is commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65` on [PyPI](https://pypi.org/project/Flask/), which matches the statement's `22d92470` |
| Task A target | `get_debug_flag` in `src/flask/helpers.py` reads `FLASK_DEBUG`; its docstring opens "Get whether debug mode should be enabled for the app..." |
| `flask --help` | The 3.1.x notes say it loads the app and plugins first so all commands show; register the new command beside `run`, `shell` and `routes` |
| Likely Task B files | `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` and `CHANGES.rst`; confirm on the checkout |

### Fork options, re-checked

| Project | Licence | Status found in November 2026 | Verdict |
| --- | --- | --- | --- |
| Roo Code | Apache-2.0 | Shut down on 15 May 2026; repository archived ([source](https://www.morphllm.com/roo-code)) | Do not fork |
| Continue | Apache-2.0 | Final 2.0.0 release; repository read-only ([source](https://github.com/continuedev/continue)) | Reference only |
| Cline | Apache-2.0 | Still maintained, now organised around an SDK ([source](https://www.morphllm.com/roo-code)) | Reference only; its loop is the part to remove |
| opencode | MIT | Active ([source](https://signpath.org/projects/opencode)); its VS Code extension appears to be a thin terminal launcher | Little editor code to reuse |

Decision: build from scratch and write "from scratch" under write-up heading 2. If any snippet is borrowed, keep its licence notice and declare it.

## 16. Problem-statement audit, line by line

Every requirement in the statement was checked against this blueprint. Status: **Covered** means the design already met it, **Fixed** means this update changed the design, **Added** means a new element was needed. Nothing is left uncovered.

### Objective and challenge question

| # | The statement says | How the blueprint meets it | On-screen proof | Status |
| --- | --- | --- | --- | --- |
| 1 | "it loses track of the file you care about" | The active file and `@` mentions are pinned into every request; the Context Receipt lists them | Receipt in Task B | Added (F13) |
| 2 | "it rewrites a function you did not ask it to touch" | Inline edits are locked to the selected range; blocks outside it are flagged in review | "Outside selection" badge | Added (F13) |
| 3 | "it confidently edits a symbol that does not exist" | `stage_edit` checks the anchor text and the symbol against the index and answers with "did you mean"; a syntax check runs on staged files | Error text in the session page | Added (F13) |
| 4 | "read the code, plan a change, edit several files" | `declare_context` now carries ordered plan steps, and the panel shows the plan before edits | Plan in the agent panel | Fixed |
| 5 | "present those edits for review inside the editor" | Review view with native diffs and CodeLens | Task B review | Covered |
| 6 | "making the editor experience safe and fast" | Safe: change set and checkpoints. Fast: latency and Stop budgets measured and reported | Numbers in the write-up | Added |
| 7 | Finds the right code in a repository larger than the context window | Budgeted lexical, symbol and import retrieval | Receipt with budget bar | Covered |
| 8 | A multi-file change the user never spelled out | The instruction names no file; the agent discovers them | Task B diff with three or more files | Covered |
| 9 | Shows every change for review before it touches disk | Overlay, then a gated `submit_change_set` | No file changes before Accept | Covered |
| 10 | Keeps working when the model fails | Profiles, classifier, fallback | Task C toast | Covered |

### The five mandatory capabilities

| # | The statement says | How the blueprint meets it | On-screen proof | Status |
| --- | --- | --- | --- | --- |
| 11 | Inline edit: keybinding, plain-language instruction, diff rendered in the editor, accept or reject; a chat reply to copy does not count | The keybinding opens an instruction box; the proposal opens in the native diff editor beside the selection (inline mode) with Accept and Reject CodeLens above each change block | Task A | Fixed (rendering specified) |
| 12 | Agent mode: tool loop (read, search, write, run), three or more files, "until the task is done or the agent gives up" | Nine MCP tools; iteration limit; an explicit stopped state with Review, Continue and Discard | Task B and the Sessions page | Fixed (stopped state) |
| 13 | Context assembly: `@file`, `@symbol`, automatic retrieval; TrueForge's features are scored | Resolver (VS Code workspace symbols first, our index as fallback) plus `find_relevant_code`; deferred loading and compaction | Receipt; session page | Covered |
| 14 | Diff review: hunk by hunk, accept or reject each, no silent writes, undoable | Change blocks with toggleable states, atomic apply, checkpoints, an Undo command | Task A toggle; Undo segment | Fixed (toggle demo) |
| 15 | Streaming and cancellation: tokens through streaming events, interrupt, editor never blocks, consistent workspace | Delta events render live; Stop cancels, aborts tools and discards the overlay | Cancel demo before Task A | Fixed (cancel demo) |
| 16 | Out of scope: tab completion, training, hosted backend, accounts, Marketplace | None of it is built | n/a | Covered |

### Models, open source and environment

| # | The statement says | How the blueprint meets it | On-screen proof | Status |
| --- | --- | --- | --- | --- |
| 17 | Model configured in TrueForge; must not depend on one provider | Profiles reference TrueForge model names only; local endpoints are allowlisted; the fallback model differs from the primary | Task C | Fixed (allowlist) |
| 18 | Fairness: organisers may repeat a task live with their model | Model switcher, Doctor test turn, fenced-code fallback for inline edit | Section 18 playbook | Added |
| 19 | Declare every model, where it ran, cost; example config; never commit a key | Write-up heading 5; `models.example.yaml`; keys only inside TrueForge; the database stored outside the repo | README | Fixed (`SQLITE_PATH`) |
| 20 | Declare the fork point or "from scratch"; preserve licences | From scratch; any borrowed snippet credited | Write-up heading 2 | Covered |
| 21 | Star the repository, read the README and run `npx` before writing extension code | First item on today's checklist (section 18) | n/a | Added |

### Round 1 tasks and submission

| # | The statement says | How the blueprint meets it | On-screen proof | Status |
| --- | --- | --- | --- | --- |
| 22 | Repository pallets/flask 3.1.3, commit 22d92470 | Commit confirmed against PyPI; tag checked out before recording | Terminal shows the tag | Covered |
| 23 | Task A verified with `FLASK_DEBUG=off python -c ...` showing False | In the run order; record in bash or WSL, or adapt the syntax and say so in a caption | Output `False` | Fixed (Windows note) |
| 24 | Task B: no files named; `pytest tests/test_cli.py -q` passes; new command prints masked JSON; diff touches three files | Workflow requires code, test and docs; masking rule has its own test | pytest, `flask config`, `git diff --stat` | Covered |
| 25 | Task B: show the TrueForge session | Session page for about 15 s | Turns, tool calls, approval pause | Covered |
| 26 | Task C: unreachable endpoint or invalid key, repeat Task A; editor responsive; clear message or automatic second model; `git status` shows no changes | Fallback applies to inline mode too; the fallback diff is rejected, not accepted | Toast, then clean status | Fixed (reject all) |
| 27 | Video: 4 minutes at most, A then B then C, each verified, no cut between instruction and diff | Revised script of about 3:45 with captions (section 10) | The video | Fixed |
| 28 | Write-up: PDF, 1 to 3 pages, eight headings in order | Template with word budgets (section 13) | The PDF | Added |
| 29 | Repository: README from a clean clone, including how to start TrueForge and load the agent definition; example model config; LICENSE; no secrets | Start script, setup script, manifests under `trueforge/agents`, secret scan | Clean-clone test | Fixed |
| 30 | All three as public links before the deadline | PDF hosted publicly; every link opened in a private window | n/a | Added |

### Eligibility, process, Round 2 and rules

| # | The statement says | How the blueprint meets it | On-screen proof | Status |
| --- | --- | --- | --- | --- |
| 31 | Client of a TrueForge agent through the HTTP API or SDK; renders streamed events | SDK client and event router | Session page | Covered |
| 32 | Editor capabilities exposed as MCP tools so the agent decides | Nine tools; the agent manifest holds no editor logic | Tool calls in the session | Covered |
| 33 | Local mode with `npx`; sandbox optional | Pinned `npx` command; sandbox off | n/a | Covered |
| 34 | Model configured in TrueForge; the extension must not call a provider directly | Doctor, probes and the model switcher all run as TrueForge turns; no provider URL appears in the code | Code search in CI | Fixed |
| 35 | Ties break on B, then A, then earlier submission time | Submit as soon as rehearsals pass | n/a | Covered |
| 36 | 10-minute call: walk through code and repeat Task A live with the organisers' model; an unexplained submission is replaced | Live-call playbook; every member can explain a module | Section 18 | Added |
| 37 | Round 2: a pull request to the TrueForge repository, on unseen material | Candidate pull requests prepared | Section 18 | Added |
| 38 | Social contest: hashtags, posts between 15 October and 18 December, links through the form | Post early; keep the links | n/a | Covered |
| 39 | Rules 3 to 7 and 12: own work, declared tools and models, no employer code, public licence, no copying between teams | Declarations in the write-up; licence scan; prior-art hygiene | Section 18 | Added |

## 17. Rubric coverage: the path to 100 of 100

The statement says that when a submission sits between two anchors the lower one applies, so every clause of a top anchor must be met in full and visible on screen. The target is 100; a realistic floor after rehearsals is 90.

| Criterion | Top anchor requires | What delivers it | The judge sees | Gate before recording | Residual risk and answer |
| --- | --- | --- | --- | --- | --- |
| A1 Inline edit (10) | Diff rendered with per-hunk accept and reject | Native inline diff, CodeLens per change block, toggleable block states, bulk actions | Task A: reject one block, revert it, accept each block separately | 10 real diffs, including a one-block diff, work | Merged block: split action and visible per-block controls |
| A2 Agent mode (10) | Discovers and edits three or more files unprompted | Retrieval tools, plan, staging across files; the instruction names none | Task B Review lists three or more files; `git diff --stat` | Three or more files in 8 of 10 runs | Agent edits only `cli.py`: the instructions define done as code, test and docs |
| A3 Streaming and cancellation (10) | Cancellation immediate; workspace stays consistent | Live deltas; Stop cancels, aborts tools, discards the overlay | A 12-second cancel demo before Task A, then clean `git status` | 100 random cancels leave no residue; Stop under 1 s | Not in the fixed tasks, so it must be added to the script |
| B1 Context assembly (15) | Retrieval with a size budget, strategy stated, visibly at work in Task B (the agent shows which files it chose and why) | Lexical, symbol and import retrieval; budgets; `declare_context` with plan and reasons; Receipt | The agent's own file list and reasons, with the budget bar, held on screen about 5 s | Recall@10 of 0.8 or better; evaluation table in the write-up | Agent skips the declaration: `stage_edit` refuses until it is made |
| B2 Diff safety (10) | Per-hunk review and a working undo, shown on screen | Block review; checkpoints; hash-verified undo | Undo run twice, then a clean `git status` | Apply then undo restores bytes exactly | Undo after a user edit: warn and ask, never overwrite |
| B3 Resilience (10) | Automatic fallback to a second configured model with no user action; workspace unchanged | Profiles, classifier, layered timeouts, fallback session | Task C: toast naming the switch, diff appears, Reject all, clean `git status` | Invalid key and unreachable endpoint both end in fallback; no hang; no stack trace | Error shape unknown (S7): capture on Day 1; short demo cap if a silent drop hangs |
| B4 TrueForge integration (10) | Editor tools as MCP tools, TrueForge approval driving the review, plus a context-engineering feature, explained in the write-up and visible in the session | Nine MCP tools; `submit_change_set` gated by name; deferred loading with `preload_tools`; compaction on | Session page: tool calls, the approval pause, deferred-tool discovery, token breakdown | Deferred discovery appears in 8 of 10 runs; measured tool-definition tokens saved | Agent never needs a deferred tool: defer `run_tests`, which Task B uses |
| C1 Video (10) | All three tasks complete, legible, visibly verified | Revised script with captions at 1080p | Each verification output on screen | Under 4:00 with no cut from instruction to diff | Slow model: choose the recording model on speed |
| C2 Write-up (15) | Architecture, context strategy, model setup, trade-offs, accurate scorecard with timestamps, honest limitations | Template with word budgets; scorecard filled from the final cut | Not on video | Three pages or fewer; every timestamp verified | Claims that the video does not show: write only what is shown |

### Where points are most likely lost

1. Cancellation never appears in the video, which caps A3 below 10.
2. Review is shown only as "accept all", which caps A1 at 7.
3. Undo is not shown on screen, which caps B2 at 5.
4. The Task C fallback diff is accepted, so `git status` shows changed files and B3 falls to 0 under its anchors.
5. The session page shows only sessions and turns, which caps B4 at 4 or 7.
6. The Receipt is missing, or no budget is stated, which holds B1 at 10.
7. A cut between instruction and diff, or a video over 4:00, drops C1.
8. The write-up runs over three pages, or a scorecard timestamp does not match the video, which drops C2.
9. The organisers' model cannot call tools reliably, which breaks the live Task A repeat.

### Target by group

| Group | Max | Target | Weakest point |
| --- | --- | --- | --- |
| A. Capability coverage | 30 | 30 | A3 evidence is outside the fixed tasks |
| B. Technical depth | 45 | 42 to 45 | B3 error shape; B4 session visibility |
| C. Presentation | 25 | 23 to 25 | Write-up length and accuracy |

## 18. Live call, Round 2 and prior-art hygiene

### Do today (11 November)

- [ ] Star github.com/truefoundry/trueforge, read its README and run `npx @truefoundry/trueforge@latest` once. The statement asks for this before any extension code.
- [ ] Confirm every member's registration. It closes on 15 November and each participant may register only once.
- [ ] Join the TrueForge Discord and post the five questions from section 14 in the portal's Doubt section.
- [ ] Run the open spikes S7, S9 and S10, and retest the stopped-MCP-server crash on the pinned version.
- [ ] Name settled: Swage. Re-check GitHub, npm and the VS Code Marketplace for clashes before the first commit. The command prefix is `swage.`.
- [ ] Agree that nobody reads other teams' public repositories until after submission.

### The 10-minute live call

Before the shortlist is final, each team walks through its code and repeats Task A live with a model the organisers choose. A team that cannot explain its own submission is replaced by the next team in rank.

| Minutes | Content |
| --- | --- |
| 0 to 2 | Architecture diagram: why the extension is a thin client, where state lives |
| 2 to 4 | The nine tools; why `submit_change_set` is gated by name; what Stop does, in order |
| 4 to 5 | Context strategy, budgets and the retrieval evaluation numbers |
| 5 to 9 | Live Task A with the organisers' model (steps below) |
| 9 to 10 | Questions |

**Live Task A steps**

1. Ask for the endpoint or key. Add it in TrueForge Settings, Models (a catalog provider or a custom OpenAI-compatible one). For a local address, make sure `OUTBOUND_URL_ALLOWED_HOSTS` includes it.
2. Run `Swage: Switch model` and pick it; Doctor sends a test turn through TrueForge.
3. Reset the repository (`git restore .`) and give the exact Task A instruction.
4. If the model ignores tools, the fenced-code fallback still produces a diff; if it fails outright, the fallback profile or a clear message appears.
5. Accept the blocks, run the verification command and show `False`.

Never paste a key into the extension, and keep keys out of logs.

**Questions every member should be able to answer**

- Why lexical retrieval instead of embeddings?
- Why is `submit_change_set` gated by name rather than by annotation?
- What does Stop do, in order, and why is the workspace consistent afterwards?
- What happens if the MCP server dies mid-run?
- How does fallback choose the next model, and what stops it looping?
- Where does state live, and why outside the repository?
- What would you build with another month?

Each member owns one module and can explain it in five sentences.

### Round 2 and the upstream pull request

The 15 finalists work on an unseen problem and must also raise a pull request to the TrueForge repository, which is reviewed as part of the score. Prepare a candidate now, but never depend on an unmerged change in Round 1.

| Candidate | Why it fits | Size | Note |
| --- | --- | --- | --- |
| Handle MCP reconnection failures without crashing the process | The risk hits this design directly; the public report gives a clear diagnosis | Small | Check the issue's current status and whether a fix has landed; comment on the issue before starting |
| Document localhost allowlisting for MCP servers and local models in the quickstart | It is easy to miss and cost a day of confusion | Tiny | Safe first contribution |
| A model fallback list in the agent manifest | Natural for resilience; the extension implements it client-side first | Medium | Discuss on Discord before coding |

Process: read `CONTRIBUTING.md` and `AGENTS.md` in the repository. The README says fork pull requests should change source only, because maintainers regenerate the SDK after merging. Keep the change small, add a test, and open it after the Round 1 submission.

### Prior-art hygiene (rule 12)

A public repository that describes itself as a Forge-a-thon entry (SrikarNarra16/forge-agent) appeared in search results while this blueprint was researched. Only its search snippet was seen. Do not open, clone or reuse it: the statement disqualifies every team involved in copying or sharing a submission. The architecture here follows from the statement and the official docs, and the file and agent names in section 9 were made generic. Keep your own commit history from the first commit, write every module yourselves, and expect other teams to publish early too.

## Sources

TrueForge behaviour comes from the pages below, read on 10 and 11 November 2026. The create-agent, use-agent, initial-setup and key-features pages and the bug report were opened in full; the rest were read as search excerpts, which is why section 14 still lists spikes to confirm.

- [TrueForge repository and README](https://github.com/truefoundry/trueforge)
- [Create an agent: spec, approval, defaults](https://trueforge.dev/create-agent/overview)
- [Use an agent: SDK, events, cancel, approvals](https://trueforge.dev/api/use-agent)
- [Initial setup: catalogs and settings](https://trueforge.dev/harness/initial-setup)
- [Harness capabilities: context engineering](https://trueforge.dev/key-features/overview)
- [Subagents](https://trueforge.dev/key-features/subagents)
- [Bug report: harness crashes when an MCP server goes down](https://github.com/truefoundry/trueforge/issues/878)
- [TrueForge 0.3.0 release notes](https://github.com/truefoundry/trueforge/releases/tag/@truefoundry%2Ftrueforge@0.3.0)
- [Streaming events](https://trueforge.dev/ui-sdk/reference/events)
- [Agent resumability explained](https://www.truefoundry.com/blog/agent-resumability-explained-trueforge)
- [Deferred tool loading](https://www.truefoundry.com/blog/trueforge-deferred-tool-loading)
- [Context engineering overview](https://www.truefoundry.com/docs/ai-gateway/agent-harness/context-engineering/overview)
- [Flask on PyPI, with the 3.1.3 commit](https://pypi.org/project/Flask/)
- [VS Code virtual documents guide](https://code.visualstudio.com/api/extension-guides/virtual-documents)
- [Roo Code status and Cline status](https://www.morphllm.com/roo-code)
- [Continue repository](https://github.com/continuedev/continue)
- [opencode licence](https://signpath.org/projects/opencode)
- [GUI coding agents compared](https://simeononsecurity.com/articles/gui-coding-agents-comparison/)
