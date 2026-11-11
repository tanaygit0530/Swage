#!/usr/bin/env bash
# Starts the pinned TrueForge in local (standalone) mode for Swage.
# Blueprint sections 9 and 15: pinned npx version, SQLite outside the repository,
# loopback allowlisted so local models (Ollama, llama.cpp) and Swage's MCP server are reachable.
#
# Usage: trueforge/start.sh            (port 8790)
#        PORT=8791 trueforge/start.sh
#        SQLITE_PATH=/some/where/tf.sqlite trueforge/start.sh
set -euo pipefail

# Keep in sync with src/supervisor/pin.ts (a unit test checks this).
TRUEFORGE_VERSION="0.184.2"

PORT="${PORT:-8790}"
export SQLITE_PATH="${SQLITE_PATH:-$HOME/trueforge-data/trueforge.sqlite}"
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
export HOST="${HOST:-127.0.0.1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(dirname "$SQLITE_PATH")"
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

case "$DATA_DIR/" in
  "$REPO_ROOT"/*)
    echo "SQLITE_PATH must be outside the Swage repository (got $SQLITE_PATH)." >&2
    exit 1
    ;;
esac

# Run from the data folder so nothing TrueForge writes lands in a repository.
cd "$DATA_DIR"
echo "Starting TrueForge $TRUEFORGE_VERSION on http://$HOST:$PORT (database: $SQLITE_PATH)"
exec npx --yes "@truefoundry/trueforge@${TRUEFORGE_VERSION}" --port "$PORT"
