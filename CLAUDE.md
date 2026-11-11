# Swage — standing rules

Swage is a VS Code coding-agent extension for the TrueFoundry Forge-a-thon (Techfest 2026-27).
These rules apply to every session working in this repo.

## Before planning
- Read `docs/BLUEPRINT.md` and `docs/PROBLEM_STATEMENT.pdf` before planning any work.
- Blueprint section numbers are the source of truth. Reference them in plans, commits and PROGRESS entries.

## Architecture
- The agent loop must run on TrueForge only. The extension never calls a model provider directly.
- Do not invent TrueForge APIs. Check the real repo (github.com/truefoundry/trueforge) and its docs, and record what you verified in `docs/SPIKES.md`.
- Prefer free and open-source dependencies only.

## Secrets
- Never write, log, print or commit an API key or token.
- No keys in the repo, in tests or in screenshots.
- Redact secrets in any tool output.

## Workflow
- Work in small steps.
- Write tests first or with the code. Every module needs unit tests that run without VS Code and without network.
- Before every commit run `npm run lint`, `npm test` and `npm run build` (once they exist). Never commit a red build.
- After every logical change that builds and passes its tests, make a git commit with a Conventional Commit message (`feat`, `fix`, `test`, `docs`, `chore`, `refactor`).
- Push to `origin main` after each phase and whenever a feature is demonstrably working.
- Keep `docs/PROGRESS.md` up to date: at the end of each phase append what was built, what was tested, and what is open.
