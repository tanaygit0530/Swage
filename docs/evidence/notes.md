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
