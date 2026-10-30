#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v uv >/dev/null || { echo '请先安装 uv: https://docs.astral.sh/uv/'; exit 1; }
command -v npm >/dev/null || { echo '请先安装 Node.js >= 22'; exit 1; }
if [ ! -f "$ROOT_DIR/backend/.env" ]; then
  cp "$ROOT_DIR/backend/.env.example" "$ROOT_DIR/backend/.env"
  chmod 600 "$ROOT_DIR/backend/.env"
fi
(cd "$ROOT_DIR/backend" && uv sync --frozen)
(cd "$ROOT_DIR/frontend" && npm ci)
(cd "$ROOT_DIR/backend" && exec uv run uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!
(cd "$ROOT_DIR/frontend" && exec npm run dev) &
FRONTEND_PID=$!
cleanup() { kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
echo '伴学启动中：http://localhost:3000 · API：http://127.0.0.1:8000/docs'
wait
