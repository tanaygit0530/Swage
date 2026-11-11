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
