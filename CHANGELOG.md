# Changelog

All notable changes to Swage. Dates are in 2026. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 12 November (Round 1 submission)

The first release. Built from scratch for the TrueFoundry Forge-a-thon (Techfest 2026-27); the agent loop runs on TrueForge 0.184.2.

### Added

- **Inline edit** (`Swage: Inline Edit`, Cmd/Ctrl+Alt+K):
  - It edits the selection, or the function around the cursor, according to a plain-language instruction.
  - The result opens as a native diff in the editor with Accept, Reject and Split on every block, plus Accept all, Reject all, Apply and Discard.
  - Edits are locked to the selected range, and a code-block reply is used when a model calls no tool.
- **Agent mode** (`Swage: Open Agent Panel`):
  - A TrueForge agent searches, reads, plans, stages edits across files, runs tests and submits a change set for review.
  - The panel streams the plan, the Context Receipt with its token budget, and every tool call.
- **Context engine:** a tree-sitter symbol index, BM25 lexical search, an import graph and a ranked repo map, all within token budgets, plus `@file` and `@symbol` mentions. On Flask 3.1.3, retrieval reaches recall@10 of 1.000 and recall@5 of 0.970 over 11 labelled queries.
- **Nine MCP editor tools** served to TrueForge over Streamable HTTP with a bearer token:
  - `find_relevant_code`, `repo_map`, `read_files`, `get_symbol`, `declare_context`, `stage_edit`, `run_tests`, `run_command` and `submit_change_set`.
  - Approval for `submit_change_set` and `run_command` is gated by name; rare tools are deferred.
- **Review and undo:**
  - A Review view of files and blocks, with native diffs, per-block decisions and an atomic apply through one WorkspaceEdit after a hash check.
  - Two-level undo from checkpoints that survive a window reload.
- **Streaming and cancellation:** Stop (Escape) flips the UI at once, cancels the TrueForge turn, aborts tool processes and discards staged edits. The workspace never changes.
- **Resilience:**
  - Model profiles with layered connect, first-token, stall and total timers, and an error classifier (hard, transient, fatal).
  - Automatic fallback that carries the task over to the next profile, a recovery offer, `Swage: Switch Model` and a status bar item.
- **Swage: Doctor:** Node, TrueForge, the MCP server and its token, agents, a tool-calling probe per model, ripgrep, Python, pytest and workspace trust, each with a fix hint.
- **Rehearsal tooling:**
  - `scripts/rehearse.mjs` runs Tasks A, B and C on real models against a clean Flask 3.1.3 clone and records evidence (`docs/EVIDENCE.md`).
  - `npm run break-primary` and `restore-primary` support Task C.
- **Safety checks:** path containment, secret redaction in tool output, an allowlisted `run_tests`, an approval-gated `run_command`, a whole-history secret scan and a dependency licence check in CI.

### Fixed during rehearsals

- The inline agent now preloads its tools. TrueForge's deferred-tools instruction otherwise made the model discover preloaded tools, which cost three turns and about 9,500 tokens per edit.
- Gemini's "Please retry in Ns" is honoured, and a long requested wait moves on to the next profile.
- `read_files` keeps the line range when a model nests the file list.
