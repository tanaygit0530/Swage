# Round 1 submission checklist

**Deadline:** 20 November 2026, 23:59 IST, through the Techfest Competition Portal. Aim for 19 November. Submit three **public** links: the repository, the video and the PDF.

| Item       | Value                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Repository | <https://github.com/tanaygit0530/Swage>                                                                    |
| Code at    | `8acac871c136a75132b415c24c25fe31748fc5fb` (13 November 2026); this checklist was added in the next commit |
| TrueForge  | 0.184.2 (pinned in `trueforge/start.sh` and `src/supervisor/pin.ts`)                                       |
| Flask      | 3.1.3, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`                                                   |
| Audit      | `docs/AUDIT.md`: provisional 82 to 85 of 100 before the video and PDF                                      |
| Evidence   | `docs/EVIDENCE.md`, `docs/evidence/` (redacted run logs)                                                   |

## Repository (do these first)

- [ ] **Make the repository public.** It currently answers 404 to the public: GitHub → Settings → General → Danger Zone → Change visibility. Then open the link in a private browser window.
- [ ] CI is green on the last commit (Linux and macOS required; Windows is experimental).
- [ ] Run the final checks one more time:
  ```bash
  ./scripts/verify.sh && npm run test:integration && npm run scan:secrets && npm run check:licences
  ```
- [ ] Optional: tag and draft a release with the VSIX (`docs/RELEASE.md`).
- [ ] Before any action that needs it: star github.com/truefoundry/trueforge and join its Discord (statement, "Start here").

## Before recording

- [ ] **Pick a model that can finish Task B.** On 13 November none of the free models available could (`docs/evidence/notes.md`, section 5). Use one of these:
  - a paid Gemini key, entered in TrueForge;
  - a Groq model your key can use (for example `openai/gpt-oss-120b`), added in TrueForge Settings → Models;
  - an Ollama model with tool support (for example `qwen2.5:7b` or `llama3.1:8b`).

  Then add it in the agent panel with **Other models… → Add a model from TrueForge…**, and run Task B once off camera.

- [ ] `trueforge/start.sh` is running; **Swage: Doctor** is all green.
- [ ] Flask at 3.1.3 with a clean `git status`. If `.venv/` shows, run `echo '*' > .venv/.gitignore`.
- [ ] `../flask/.vscode/settings.json` lists the models; the panel's model picker shows the one you want.
- [ ] Notifications off; editor and terminal fonts at 16 or larger; any Settings page showing a key is closed.
- [ ] The TrueForge Sessions page is open in a browser tab.
- [ ] `/tmp/demo_app.py` exists for the masked-JSON check (`docs/DEMO_SCRIPT.md`).

## Video (at most 4:00): follow `docs/DEMO_SCRIPT.md`

- [ ] Title shot with the Doctor report.
- [ ] **A0 cancel:** Escape while it streams → "Cancelled. Workspace unchanged." → `git status` empty.
- [ ] **Task A:** the exact instruction, with **no cut** until the diff. Reject block 1, revert it, accept each block, Apply. `FLASK_DEBUG=off … print(get_debug_flag())` shows `False`.
- [ ] **Task B:** the exact instruction with no file named, and **no cut** until the review.
  - Hold about 5 s on the plan with files and reasons, and on the budget bar.
  - Show the **TrueForge session page**: tool calls, the approval pause, and the `list_tools` / `get_tool_info` discovery of `run_tests`.
  - Accept All, Apply. Then `pytest tests/test_cli.py -q` passes, `flask --help` lists `config`, the masked JSON appears, and `git diff --stat` shows 3 or more files.
- [ ] **Undo twice** → `git status` empty.
- [ ] **Task C:** `npm run break-primary -- --workspace ../flask`, then repeat Task A while typing in another file. The toast names the switch, the diff appears, **Reject all**, and `git status` is empty. Afterwards run `npm run restore-primary`.
- [ ] Outro card with each criterion's timestamp.
- [ ] Length under 4:00, legible at 1080p, nothing cut between an instruction and its diff, no key visible.
- [ ] Upload as YouTube unlisted (or Drive, "anyone with the link"). Put the timestamps in the description and open the link in a private window.

## Write-up PDF (1 to 3 pages): from `docs/WRITEUP.md`

- [ ] Section 1: team name, members, college or employer, GitHub handles.
- [ ] Section 6: replace every `⟨mm:ss⟩` with the real timestamp from the final video; check each claim against what the video shows.
- [ ] Add the video link at the top.
- [ ] If a different model was used for the recording, update section 5 (models, where they ran, cost).
- [ ] Export to PDF (VS Code Markdown preview → Print → Save as PDF, or `pandoc docs/WRITEUP.md -o writeup.pdf`). Check that it is **3 pages or fewer** and the 8 headings are in order.
- [ ] Host it publicly (the repository's `docs/` folder, or Drive with "anyone with the link") and open the link in a private window.

## Submit

- [ ] Portal: the repository link, the video link and the PDF link, all public. Do this by 19 November.
- [ ] Optional social contest: post the video on LinkedIn, X or YouTube with #TrueForge #Forgeathon #YourTeamName, and keep the links for TrueFoundry's form (by 18 December).
- [ ] Before the live call: practise **Other models… → Add a model from TrueForge…** with a model you have not used, and run Task A with it.
