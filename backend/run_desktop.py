"""Frozen desktop entry. Uses only the bundled Python runtime and local resources."""

import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    os.environ["TIKTOKEN_CACHE_DIR"] = str(Path(sys._MEIPASS) / "tokenizer")

import uvicorn  # noqa: E402
from app.main import app  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ["DESKTOP_PORT"]),
        workers=1,
        access_log=False,
        log_level="error",
        loop="asyncio",
        http="h11",
    )
