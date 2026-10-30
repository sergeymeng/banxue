#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$ROOT_DIR/frontend" && npm ci && DESKTOP_BUILD=1 npm run build)
mkdir -p "$ROOT_DIR/build/desktop-resources" "$ROOT_DIR/build/tokenizer"
(cd "$ROOT_DIR/backend" && uv sync --frozen && TIKTOKEN_CACHE_DIR="$ROOT_DIR/build/tokenizer" uv run python -c 'import tiktoken; tiktoken.get_encoding("cl100k_base")')
(cd "$ROOT_DIR/backend" && uv run pyinstaller --noconfirm --clean --onedir --name tutor-engine --distpath "$ROOT_DIR/build/desktop-resources" --workpath "$ROOT_DIR/build/pyinstaller" --specpath "$ROOT_DIR/build" --collect-submodules app --collect-submodules tiktoken_ext --collect-submodules uvicorn --collect-submodules sqlalchemy.dialects.sqlite --hidden-import pydantic_settings --copy-metadata tiktoken --add-data "$ROOT_DIR/build/tokenizer:tokenizer" run_desktop.py)
mkdir -p "$ROOT_DIR/build/desktop-resources/web"
rsync -a --delete "$ROOT_DIR/frontend/out/" "$ROOT_DIR/build/desktop-resources/web/"
(cd "$ROOT_DIR/desktop" && npm ci && npm run package)
