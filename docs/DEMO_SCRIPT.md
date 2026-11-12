# Demo video script (Round 1, at most 4:00)

The video must show Tasks A, B and C on Flask 3.1.3 in that order, each followed by its on-screen verification, and briefly show the TrueForge session during Task B. **Never cut between giving an instruction and the diff appearing.** Model waiting time may be cut elsewhere. This script follows blueprint section 10 and adds the shots the rubric needs that the fixed tasks do not contain: a cancel, a per-block toggle, a double undo, and Reject all after the fallback.

Target length 3:45, leaving 15 s of margin. Record at 1080p, with the editor font at 16 or more and the terminal font at 16 or more.

## Before recording (not filmed)

1. **TrueForge:**
   ```bash
   trueforge/start.sh
   ```
   Then open <http://localhost:8790> in a browser tab and keep its **Sessions** page ready.
2. **Flask:**
   ```bash
   cd ../flask && git checkout 3.1.3 && git status
   ```
   It must show a clean tree at commit `22d92470`. The `.venv` has Flask installed in editable mode and pytest 9.0.2 (see `node scripts/rehearse.mjs setup` for the pinned list).
3. **Profiles:** `../flask/.vscode/settings.json` holds `swage.models`, with a fast primary and a working fallback. The rehearsal used `gemini-flash-lite-latest` and `gemini-3-5-flash-lite`. Warm both up with one inline edit each, then Undo.
4. **Swage:** press F5 and pick **Run Swage on Flask (../flask)**. Run **Swage: Doctor**; every row must be green. Keep the report tab open for the title shot.
5. **Housekeeping:**
   - Close every other editor tab.
   - Turn notifications off (macOS Focus).
   - Close any Settings pages so no key is visible.
   - Open a terminal panel in the Flask folder.
6. **Practice** the Task A selection: lines 28 to 33 of `src/flask/helpers.py`.

## Shot list

| Time      | Segment             | Action (exact)                                                                                                                                                                                                                                            | Must be on screen                                                                                                                    | Rubric |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 0:00–0:06 | Title               | Caption "Swage · Flask 3.1.3 · TrueForge 0.184.2 local mode". Show the **Swage: Doctor** report (all green) for 3 s.                                                                                                                                      | Doctor table; status bar "Swage: Gemini Flash Lite"                                                                                  | C1     |
| 0:06–0:18 | A0 Cancel           | Select `get_debug_flag` (lines 28–33), press **Cmd+Alt+K**, paste the Task A instruction, Enter. When the status bar streams text, press **Escape**. Then run `git status --short` in the terminal.                                                       | Spinner with streamed text; "Cancelled. Workspace unchanged."; empty `git status`                                                    | A3     |
| 0:18–0:40 | A Inline edit       | Same selection, **Cmd+Alt+K**, the same instruction, Enter. **No cut** until the diff appears.                                                                                                                                                            | The diff in the editor with "Block 1/2 … ✓ Accept · ✗ Reject" lenses                                                                 | A1     |
| 0:40–0:55 | A Per-block review  | Click **✗ Reject** on Block 1 (it disappears), then **Accept instead** (it returns). Click **✓ Accept** on Block 2. Click **Apply**.                                                                                                                      | Each block toggling; the "Applied 1 file(s)" toast with Undo                                                                         | A1, B2 |
| 0:55–1:02 | A Verify            | Run `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`.                                                                                                                                            | Output `False`                                                                                                                       | A1     |
| 1:02–1:12 | B Instruction       | Swage icon, then the Agent panel. Paste the Task B instruction (no file named). Enter.                                                                                                                                                                    | The instruction text, with no file names                                                                                             | A2     |
| 1:12–1:50 | B Plan and context  | Let it run. **Hold 5 s on the plan card** and the context meter. Tool rows stream in (`find_relevant_code`, `read_files`, `declare_context`, `stage_edit` ×3, `run_tests`).                                                                               | Plan with files and reasons; budget bar; tool timeline                                                                               | B1, A3 |
| 1:50–2:05 | B TrueForge session | Switch to the browser **Sessions** page and open this run.                                                                                                                                                                                                | Turns, MCP tool calls, the approval pause on `submit_change_set`, the deferred `run_tests` discovery (`list_tools`, `get_tool_info`) | B4     |
| 2:05–2:22 | B Review and Apply  | Back in VS Code. The **Review** view lists 3+ files. Open `cli.py` to show a diff, then **Accept All**, then **Apply**.                                                                                                                                   | File list with block counts; one diff; the apply toast                                                                               | A2, B2 |
| 2:22–2:47 | B Verify            | Run `.venv/bin/python -m pytest tests/test_cli.py -q`, then `.venv/bin/flask --help \| grep config`, then `.venv/bin/flask --app /tmp/demo_app.py config` (`demo_app.py` prepared before: `SECRET_KEY`, `API_TOKEN`, `GREETING`), then `git diff --stat`. | "passed"; the `config` line; masked JSON with `"***"`; 3+ files changed                                                              | A2     |
| 2:47–2:59 | Undo twice          | **Swage: Undo Last Change Set**, then again. Then `git status --short`.                                                                                                                                                                                   | Two "Restored …" toasts; empty `git status`                                                                                          | B2     |
| 2:59–3:05 | C Break the primary | In a second terminal (Swage folder), run `npm run break-primary -- --workspace ../flask`. A caption may say "primary model now unreachable".                                                                                                              | "Primary broken"                                                                                                                     | B3     |
| 3:05–3:35 | C Repeat Task A     | Select lines 28–33, **Cmd+Alt+K**, the Task A instruction, Enter. While it runs, type in another file to show the editor responds. **No cut** until the diff.                                                                                             | Toast "Switched to … because … refused the connection."; status bar in warning colour; the diff                                      | B3, A3 |
| 3:35–3:41 | C Reject all        | Click **Reject all**, then **Discard**. Run `git status --short`. Optionally run `npm run restore-primary` after the cut.                                                                                                                                 | Empty `git status`                                                                                                                   | B3     |
| 3:41–3:45 | Outro               | A card listing each criterion with its timestamp (copy the table below).                                                                                                                                                                                  | –                                                                                                                                    | C1     |

**Exact instructions** (from the problem statement; type or paste them verbatim):

- **Task A:** Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
- **Task B:** Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

## Rubric checklist (fill the real timestamps into docs/WRITEUP.md, section 6)

| Criterion                     | Shown at             | What a judge must see                                                                            |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| A1 Inline edit                | 0:18–1:02            | Keybinding, instruction, diff in the editor, a block rejected, reverted, and each block accepted |
| A2 Agent mode                 | 1:02–2:47            | No file named; Review lists three or more files; tests pass; masked JSON                         |
| A3 Streaming and cancellation | 0:06–0:18, 1:12–1:50 | Tokens streaming; Stop answers at once; clean `git status`                                       |
| B1 Context                    | 1:12–1:50            | Plan, files with reasons, budget bar held about 5 s                                              |
| B2 Diff safety                | 0:40–0:55, 2:47–2:59 | Per-block review; Undo twice; clean `git status`                                                 |
| B3 Resilience                 | 2:59–3:41            | Toast naming the switch, no click; diff; Reject all; clean `git status`                          |
| B4 TrueForge                  | 1:50–2:05            | Session page: tool calls, the approval pause, deferred discovery                                 |
| C1 Video                      | whole                | Under 4:00; each verification legible; no cut from instruction to diff                           |

## If something goes wrong

- **Task B is slow on a free tier.** It took 7.8 minutes once in rehearsal. Use a faster or paid model for the recording; the rubric scores behaviour, not model choice. The uncut part runs from the instruction to the Review view.
- **The primary hits a quota mid-take.** Swage switches by itself; keep filming, because that is B3 evidence too. Mention it in a caption.
- **Something is left over:** before each take, run `git status --short` in Flask. If it isn't clean, run **Swage: Undo Last Change Set** or `git checkout -- . && git clean -fd -e .venv -e .vscode`.
