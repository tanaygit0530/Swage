# Releasing Swage 0.1.0 (draft, not published)

The VSIX is a build artefact, so it is not committed (`*.vsix` is git-ignored). Attach it to a **draft** GitHub release, review it, and publish it only when the team decides.

## 1. Build and check the package

```bash
git checkout main && git pull
npm ci
./scripts/verify.sh                 # lint, unit tests, build
npm run scan:secrets && npm run check:licences
npm run package                     # writes swage-0.1.0.vsix
shasum -a 256 swage-0.1.0.vsix      # record the checksum in the release notes
```

The package should list 19 files (about 1 MB): `dist/extension.js`, `dist/webview.js`, `dist/webview-style.css`, five tree-sitter `.wasm` files, `media/icon.png`, `media/swage-icon.svg`, `media/swage-logo.svg`, both agent manifests, README, CHANGELOG and LICENSE. There is no source, no `node_modules`, and no `config/` or `docs/`.

Optionally, install it into a throwaway profile before releasing:

```bash
code --user-data-dir /tmp/swage-ud --extensions-dir /tmp/swage-ext --install-extension swage-0.1.0.vsix
```

## 2. Create the draft release

With the [GitHub CLI](https://cli.github.com), logged in as the repository owner. `--draft` keeps it private to collaborators until it is published.

```bash
git tag -a v0.1.0 -m "Swage 0.1.0 (Round 1 submission)"
git push origin v0.1.0
gh release create v0.1.0 swage-0.1.0.vsix \
  --draft \
  --title "Swage 0.1.0" \
  --notes "Round 1 submission of Swage, an editor-native coding agent for VS Code on TrueForge 0.184.2. Install with: code --install-extension swage-0.1.0.vsix. Setup, model profiles and limitations: see the README. Changes: see CHANGELOG.md. SHA-256: <paste the checksum>."
```

Without the CLI: open **Releases → Draft a new release** on GitHub, choose the tag `v0.1.0`, upload `swage-0.1.0.vsix`, paste the notes, and press **Save draft**, not Publish.

## 3. Publish (only when ready)

Open the draft on GitHub, check the asset downloads and installs, then press **Publish release**. A published release is public. The Round 1 form needs the repository link, not the release.
