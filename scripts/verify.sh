#!/usr/bin/env bash
# Runs the pre-commit checks from CLAUDE.md and stops at the first failure.
set -euo pipefail
npm run lint --silent
npm test --silent
npm run build --silent
echo "verify: lint, test and build passed"
