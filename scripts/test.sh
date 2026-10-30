#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$ROOT_DIR/backend" && uv sync --frozen && uv run pytest -q)
(cd "$ROOT_DIR/frontend" && npm ci && npm run typecheck && npm test && npm run build)
