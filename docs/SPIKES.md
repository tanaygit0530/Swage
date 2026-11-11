# Spikes

What was verified, how, and what it decided. Blueprint section numbers refer to `docs/BLUEPRINT.md`.

## Tree-sitter for the context engine (11 November 2026)

**Question.** Can the context engine (blueprint section 7) parse Python, TypeScript and JavaScript with tree-sitter offline, inside a VS Code extension, without native modules or install scripts? If not, fall back to the regex extractor in `src/changeset/symbols.ts`.

**Verified.**

- Package: `@vscode/tree-sitter-wasm@0.3.1` (MIT, published by the VS Code team). It ships the web-tree-sitter runtime (`wasm/tree-sitter.js`, `tree-sitter.wasm`) with grammars built against it, including `tree-sitter-python.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` and `tree-sitter-javascript.wasm`. Because the runtime and grammars come from one package, there is no ABI mismatch between them.
- No install script, no native build, no network at runtime: grammars load from local files.
- API used: `Parser.init({ locateFile })`, `Language.load(path)`, `new Parser().setLanguage(lang)`, `parser.parse(text)`, `Node.namedChildren`, `Node.childForFieldName`, `tree.delete()`. Types come from `wasm/web-tree-sitter.d.ts` and resolve under strict TypeScript.
- Runtime init plus loading the Python grammar took about 12 ms on this machine (Node 26.8, Apple Silicon).
- Works under Vitest (ESM) and in an esbuild CJS bundle, with WASM files loaded from a copied folder.

**Decision.** Use tree-sitter. `src/context/symbols.ts` builds a parser with `createParser({ wasmDir })`. The build copies the five WASM files to `dist/wasm`, and `.vscodeignore` ships them in the `.vsix`. If loading fails (files missing, or an unsupported runtime), `createParser` falls back to the regex parser and reports the reason through `onFallback`. `toSymbolExtractor` plugs the tree-sitter parser into the change-set `SymbolExtractor` hook.

**Node types relied on.** Python: `class_definition`, `function_definition`, `decorated_definition`, `expression_statement` > `assignment`, `import_statement`, `import_from_statement` (field `module_name`), `aliased_import`. TypeScript/JavaScript: `function_declaration`, `generator_function_declaration`, `class_declaration`, `abstract_class_declaration`, `class_body` > `method_definition`, `abstract_method_signature`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `lexical_declaration`/`variable_declaration` > `variable_declarator`, `import_statement` (field `source`), `export_statement` (fields `declaration`, `source`), `export_clause` > `export_specifier`. All are covered by `test/unit/context/symbols.test.ts`, so a grammar upgrade that renames one fails a test.

**Sizes.** The five WASM files total 3.8 MB uncompressed in `dist/wasm`.

## TrueForge integration (11 November 2026)

Sources inspected: the TrueForge repository at tag `@truefoundry/trueforge@0.184.2` (commit `235518c`), including `docs/` (use-agent, create-agent, mcp-servers, initial-setup), `docs/openapi.json` (OpenAPI 3.1, info.version 0.184.1) and `packages/trueforge/src` (`cli.ts`, `config.ts`, `main.ts`, `app.ts`); the published `@truefoundry/trueforge-sdk@0.184.1` package (types in `dist/cjs`, `reference.md`); and upstream issue 878 through the GitHub API. Live checks ran against the user's TrueForge 0.184.2 at `http://localhost:8790` and against throwaway instances started by the supervisor.

### Versions

| Item            | Verified value                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Server          | `@truefoundry/trueforge@0.184.2`, npm `latest` on 11 November 2026; the running server reports `{"status":"ok","version":"0.184.2"}` |
| SDK             | `@truefoundry/trueforge-sdk@0.184.1`, the newest published; no 0.184.2 SDK exists                                                    |
| Node            | `engines.node >=22.14.0` in the server package                                                                                       |
| Pinned in Swage | `src/supervisor/pin.ts`, `trueforge/start.sh` and `start.ps1`; a unit test keeps them equal                                          |

### Server startup (from `cli.ts`, `config.ts`, `main.ts`)

- `npx @truefoundry/trueforge --port <n>` sets `PORT` before the server loads; the default port is 8790.
- `HOST` defaults to `localhost`. Swage sets `HOST=127.0.0.1` so the bind address is deterministic.
- `SQLITE_PATH` is optional; the default is `{env-paths data}/db/db.sqlite`. The user's instance already used `~/trueforge-data/trueforge.sqlite`, so Swage defaults to that file to keep the configured models.
- `OUTBOUND_URL_ALLOWED_HOSTS` is a JSON string array of exact host names. Without it, an SSRF guard blocks loopback and private addresses (`trueforge-core/src/core/util/ssrfGuard.ts`).
- `GET /healthz` returns `{ "status": "ok", "version": "<v>" }` and is skipped by the request log.
- SIGTERM and SIGINT run a graceful shutdown that closes the database and exits 0.
- Model HTTP timeouts: connect 5 s, headers 20 s, body 2 min (`MODEL_HTTP_*_TIMEOUT_MS`). General outbound timeouts are 5 s with 2 retries.
- Standalone mode prints a warning box saying it is meant for local use only.

### REST and SDK shapes used by Swage

| Need                    | Verified API                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Register the MCP server | `PUT /api/v1/settings/mcp-servers` (`settings.mcpServers.createOrUpdate`), "create or replace by name"; body `{ manifest: { type: "remote", name, url, description, auth: { type: "header", headers } } }`. POST fails with 409 if the name exists. Header values are redacted in responses.                                                                                                                                   |
| List its tools          | `GET /api/v1/mcp-servers/{name}/tools` (`mcpServers.listTools`); entries are plain records                                                                                                                                                                                                                                                                                                                                     |
| Agents                  | `GET /api/v1/agents?agent_name=` (case-insensitive substring), `POST /api/v1/agents` (409 if the name is taken; names are immutable), `PUT /api/v1/agents/{agent_id}` by immutable id. Swage upserts by listing, matching the exact name, then updating or creating.                                                                                                                                                           |
| Names                   | `ResourceName` = `^[a-z][a-z0-9-]{0,62}[a-z0-9]$`; so agents are `swage-main-<profile>` and `swage-inline-<profile>`                                                                                                                                                                                                                                                                                                           |
| Agent manifest          | `AgentSpec { model { name, params }, instructions, mcp_servers[], skills, messages, response_format, config }`. `MCPServer { name, enable_tools = ["@all"], disable_tools, preload = false, preload_tools, require_approval_for_tools = ["@write","@destructive"] }`. `RuntimeConfig` defaults: sandbox off, generative UI on, questions on, dynamic subagents on, compaction on, large tool response on, iteration limit 512. |
| Sessions                | `sessions.create({ agent: { name } })` or `{ agent: { spec } }`; named sessions resolve the live agent on every turn                                                                                                                                                                                                                                                                                                           |
| Turns                   | `sessions.createTurnStream(id, { input, previousTurnId? })` returns an async-iterable SSE stream with built-in reconnection; `subscribeToTurn` resumes after a sequence number                                                                                                                                                                                                                                                 |
| Approvals               | resume with one `user.tool_approval { threadId, toolCallId, approval: { status: "allow" } \| { status: "deny", reason? } }` per pending call; a turn cannot mix these with a `user.message`                                                                                                                                                                                                                                    |
| Cancel                  | `sessions.cancel(sessionId)`: aborts the model request, waits for running MCP calls, idempotent; the stream ends itself with `turn.done` (cancelled)                                                                                                                                                                                                                                                                           |
| Models                  | `GET /api/v1/models` returns FQNs (`google-gemini/gemini-3-5-flash`) plus the upstream `model_id` and properties; no keys                                                                                                                                                                                                                                                                                                      |
| Model providers         | `PUT /api/v1/settings/model-providers` with `{ type: "custom", name, base_url, models: [{ name, model_id, properties }], auth?: { api_key } }`; DELETE is rejected while an agent uses the provider                                                                                                                                                                                                                            |

### Events (SDK 0.184.1)

- A stream opens with `turn.created` and closes with `turn.done`. `turn.done.state` is `done` (`output`, `requiredActions`, `completedAt`, `metrics`), `cancelled` (`reason`: `client-cancelled`, `server-execution-timeout`, `cancelled-for-next-turn`, `abandoned`) or `error` (`message`).
- Model output is an empty `model.message` base followed by `model.message.delta` events with the same `id`; the SDK's `mergeEventDelta` merges text and tool-call fragments by index (verified in `test/unit/client/client.test.ts` with a split tool call).
- `ToolCall.toolInfo` is `{ type: "mcp", name, serverId, serverName }` or `{ type: "truefoundry-system", name }`.
- `tool.approval_required.toolCalls` holds `{ id, sourceEventId }`; the name and arguments live in the `model.message` with that id.

### Surprises

1. **The SDK's CommonJS build cannot be `require()`d by plain Node 26.** The package has `"type": "module"` and ships `dist/cjs/*.js` without a nested `package.json`, so Node treats those files as ES modules and `require("./api/index.js")` fails. `import` (ESM build) works, and so do esbuild bundles. Swage imports the SDK with `import`; `scripts/run.mjs` bundles scripts with esbuild for the same reason.
2. **The SDK's event union has five types the docs do not list:** `thread.context_compaction.started`, `thread.context_compaction.finished`, `turn.update` (state `running` or `paused` with `actionRequiredOnEvents`), `user.mcp_auth_continue` and `user.tool_approval_policy`. Swage's event mapper ignores unknown types.
3. **The SDK uses camelCase objects but the docs and manifests use snake_case.** `serialization.AgentSpec.parseOrThrow(raw, { unrecognizedObjectKeys: "fail" })` converts a wire manifest and rejects unknown keys such as `mcp_server`; Swage loads the committed manifests through it.
4. **TrueForge validates provider URLs when they are saved.** An unknown host or a non-allowlisted private address is rejected by `PUT /settings/model-providers` with `400 Outbound URL blocked for host "…"`, so such errors appear in Settings, not during a turn.
5. **Every model failure arrives as `turn.done` with `status: "error"`**, after an empty `model.message`, never as a transport error. Messages are prefixed `[Model Error]` or `[MCP Error]`, but one MCP failure in an existing session arrived without a prefix (see the crash retest).
6. **TrueForge adds harness tools next to the MCP tools.** With `preload: true`, the model saw `get_current_datetime, call_tool, get_tool_info, get_tool_output_schema, list_tools` plus the MCP tools under their plain names (`read_files`, not a prefixed name).
7. **Fetch's blocked-port list applies.** A provider on `127.0.0.1:9` fails with `Cannot connect to API: bad port` without a connection attempt; S7 uses a free closed port instead.
8. **The user's TrueForge warns** "Reasoning effort is not configured for this model" for `gemini-3-5-flash`, `gemini-flash-lite-latest` and the two Gemma models.
9. **Issue 878 is still open** upstream (opened 26 September 2026 against 0.2.1), but it does not reproduce on 0.184.2 (below).

### Spike S7: error shapes and timings

Temporary custom providers on the user's TrueForge, removed afterwards. The bad-key case uses a local OpenAI-compatible fake that returns OpenAI's 401 body, so no request reached a real provider. Script: `scripts/spikes/s7-errors.ts`.

| Case                                           | Where it fails | Time to `turn.done`                                       | Message                                                                     |
| ---------------------------------------------- | -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Connection refused (`127.0.0.1:<closed port>`) | turn           | 22 ms                                                     | `[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:54895` |
| HTTP 401 invalid key                           | turn           | 21 ms, 1 request (no retry)                               | `[Model Error] Request failed (401): Invalid API Key`                       |
| Endpoint accepts but never answers             | turn           | 64.7 s, 3 requests (2 retries after 20 s header timeouts) | `[Model Error] Cannot connect to API: Headers Timeout Error`                |
| Unknown host (`*.invalid`)                     | provider save  | immediate                                                 | `400 Outbound URL blocked for host "swage-spike.invalid"`                   |
| Private address `10.255.255.1`                 | provider save  | immediate                                                 | `400 Outbound URL blocked for host "10.255.255.1"`                          |

Event sequence for turn failures: `turn.created > model.message > turn.done`.

Effect on the design (blueprint section 8): classify by message text. `401`, `403`, `ECONNREFUSED`, `bad port` and "model not found" switch to the next profile at once; `Headers Timeout Error`, `429` and `5xx` retry, then switch. A hanging endpoint costs 65 s inside TrueForge before it reports, so Swage's own first-token timer (45 s hosted; a short demo profile for Task C) must cancel and fall back first. Unreachable or private hosts are caught by Doctor when profiles are checked, because TrueForge refuses to save them.

### Spike S10: pytest in a shadow copy

Script: `scripts/spikes/s10-shadow.ts`. The real Flask checkout stayed clean.

- **Surprise: the Flask venv cannot run Flask's tests.** It has pytest 9.2.0, but Flask 3.1.3's `tests/conftest.py` uses `monkeypatch.notset`, which pytest removed after 9.0.2, so every test errors in setup (`AttributeError: module '_pytest.monkeypatch' has no attribute 'notset'`). Flask's `uv.lock` pins pytest 9.0.2 for Python 3.10 or newer. Fix: `.venv/bin/pip install pytest==9.0.2` in the Flask checkout (not done for the user; it is their environment). Without it, Task B's verification `pytest tests/test_cli.py -q` fails.
- Measured with a throwaway venv holding pytest 9.0.2 and Flask 3.1.3:
  - Run as is, pytest in the shadow imports the installed Flask from site-packages: **staged code not seen**.
  - With `PYTHONPATH=<shadow>/src`, the staged `cli.py` is imported: **staged code seen**, and Flask's full `tests/test_cli.py` passes in the shadow (58 passed in 0.13 s).
  - Shadow copy of Flask (without `.git` and `.venv`): 71 to 74 ms.
- Effect on the design: the `run_tests` shadow runner prepends `<shadow>/src` (or the shadow root for flat layouts) to `PYTHONPATH`, sets `PYTHONDONTWRITEBYTECODE=1` and passes `-p no:cacheprovider`. Doctor checks the target venv's pytest version.

### MCP-shutdown crash retest (upstream issue 878)

Script: `scripts/spikes/crash-retest.ts`. A throwaway TrueForge 0.184.2 started by Swage's supervisor on a free port with a temporary SQLite file, a local fake model and a stub MCP server (official `@modelcontextprotocol/sdk` 1.32.2, streamable HTTP, bearer auth). Fully offline; the main TrueForge was not touched.

| Step                                    | Stateless MCP server                                                                                      | Stateful MCP server (session ids, GET SSE stream)                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Turn 1, MCP up                          | `turn.created > mcp.initialize > model.message > tool.response > … > turn.done`, tool called              | same                                                                               |
| MCP server stopped; `/healthz` for 20 s | ok                                                                                                        | ok                                                                                 |
| Turn 2, same session                    | `turn.done` error `[MCP Error] Failed to connect to remote MCP server 'swage-spike-tools' … ECONNREFUSED` | `turn.done` error `fetch failed: connect ECONNREFUSED 127.0.0.1:55052` (no prefix) |
| Turn 3, new session                     | same `[MCP Error]` message                                                                                | same `[MCP Error]` message                                                         |
| Supervisor                              | stayed `ready`, never restarted                                                                           | stayed `ready`, never restarted                                                    |

**Result: TrueForge 0.184.2 did not crash** when a registered MCP server went away, in either mode; turns fail fast and cleanly. Swage keeps the protective shutdown order anyway (TrueForge first, then the MCP server), because the issue is still open and the crash path may depend on timing. Start-up of a throwaway instance: 29.6 s on the first run (npx download of the pinned version), 4.1 s once cached.

### Smoke test

`npm run smoke` on the user's TrueForge: "say hello" to `google-gemini/gemini-3-5-flash` through an inline session returned "Hello! It's wonderful to meet you today." in 2,273 ms (first text at 2,261 ms; 263 tokens, most of them the harness prompt).

### Spike S9: tool-calling probe (first run)

Script: `scripts/spikes/s9-probe.ts`. Each trial opens a fresh session with the stub MCP server's `read_files` preloaded and asks the model to read `README.md`. A trial passes if the tool was called with `README.md` and the turn ended `done`. Gate: 8 of 10.

| Profile    | Model                            | Valid tool calls | Median turn | Notes                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------- | ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| primary    | `google-gemini/gemini-3-5-flash` | **7/10**         | 6.0 s       | 2 failures were `429 You exceeded your current quota` (free tier); 1 was `Output truncated: hit the 512 token limit after 508 tokens` (the probe capped `max_tokens` at 512; Swage's profiles use 4,096). Every trial that reached the model with quota left called the tool correctly.                              |
| fallback-1 | `groq/llama-3-3-70b-versatile`   | **0/10**         | 0.3 s       | Every call: `[Model Error] Request failed (404): The model \`llama-3.3-70b-versatile\` does not exist or you do not have access to it.` The configured model is not available to this Groq key, so this profile cannot work until a model the key can use is configured.                                             |
| fallback-2 | `ollama/qwen-2-5-coder-7b`       | not measured     |             | The first trial's stream ended after 71 s with `terminated` and no `turn.done`; the user's TrueForge on port 8790 had stopped running, so every later call failed with `fetch failed` (ECONNREFUSED). The cause is not known yet: macOS logged no memory kill, and the TrueForge console was in a separate terminal. |
| fallback-3 | `llamacpp/qwen-2-5-coder-3b`     | not measured     |             | Not reached: TrueForge was down, and `llama-server` was no longer running.                                                                                                                                                                                                                                           |

Findings so far:

- Gemini Flash calls tools reliably when it has quota; the free tier's rate limit is the real risk for the recording, so record within the quota and keep one request at a time (blueprint section 14).
- New error shapes for the classifier: `429 … exceeded your current quota` (retry with backoff, then switch), `404 … does not exist or you do not have access` (switch at once: model not found), and `Output truncated: hit the N token limit` (not a provider failure; raise `max_tokens`).
- The local models must be re-run with TrueForge started from `trueforge/start.sh` in a visible terminal, one local model loaded at a time (8 GB RAM).
