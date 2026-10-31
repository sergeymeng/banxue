"""Test-only app. Run on 8100 via playwright.voice.config.ts; NEVER imported by production.

Uses real Qwen adapters, classroom service, budget ledger and local WebSocket. Only
upstream network transports are simulated. No credentials or .env are loaded.
"""
import asyncio
import base64
import copy
import json
import math
import os
import struct
import time
from pathlib import Path
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from app import voice_session
from app.config import Settings
from app.qwen_voice import QwenASR, QwenLLM, QwenTTS

# Isolate even main.py's module-level default app from a developer's .env/data.
# This module only runs in the dedicated test-server process.
Settings.model_config["env_file"] = None
for name in list(os.environ):
    if name.lower() in Settings.model_fields:
        os.environ.pop(name)
os.environ["DATA_DIR"] = "data/e2e/voice-sim"
from app.main import create_app  # noqa: E402


class Scenario(BaseModel):
    transcript: str = Field(default="为什么用 chain rule", max_length=1000)
    answer: str = Field(default="这是仿真老师的回答。先看外层函数。再看内层函数。", max_length=2000)
    asr_delay_ms: int = Field(default=20, ge=0, le=5000)
    llm_delay_ms: int = Field(default=30, ge=0, le=5000)
    tts_delay_ms: int = Field(default=20, ge=0, le=5000)
    audio_seconds: float = Field(default=2, ge=.1, le=10)
    fault: Literal["none", "asr_fail", "asr_disconnect", "llm_disconnect", "llm_timeout", "tts_fail", "tts_disconnect"] = "none"


scenario = Scenario()
trace = []
active = {"asr": 0, "llm": 0, "tts": 0}
started = time.monotonic()


def record(service, event, **data):
    trace.append({"at_ms": round((time.monotonic() - started) * 1000, 1),
                  "service": service, "event": event, **data})
    del trace[:-2000]


class Socket:
    def __init__(self, role):
        self.role, self.plan = role, copy.deepcopy(scenario)
        self.queue = asyncio.Queue()
        self.audio_bytes = 0
        self.partial = False

    async def __aenter__(self):
        active[self.role] += 1
        record(self.role, "open")
        return self

    async def __aexit__(self, *args):
        active[self.role] -= 1
        record(self.role, "close", audio_bytes=self.audio_bytes)

    async def send(self, value):
        if isinstance(value, bytes):
            self.audio_bytes += len(value)
            if not self.partial:
                self.partial = True
                self.queue.put_nowait({"header": {"event": "result-generated"}, "payload": {"output": {
                    "sentence": {"sentence_id": 1, "text": self.plan.transcript[:4], "sentence_end": False}}}})
            return
        body = json.loads(value)
        kind = body.get("type") or body.get("header", {}).get("action")
        record(self.role, kind)
        if kind == "run-task":
            assert body["payload"]["parameters"]["sample_rate"] == 16000
            assert "vocabulary" in body["payload"]["parameters"]
            self.queue.put_nowait({"header": {"event": "task-started"}})
        elif kind == "finish-task":
            if self.plan.fault == "asr_fail":
                self.queue.put_nowait({"header": {"event": "task-failed"}})
            elif self.plan.fault == "asr_disconnect":
                self.queue.put_nowait(ConnectionError("simulated ASR disconnect"))
            else:
                self.queue.put_nowait({"header": {"event": "result-generated"}, "payload": {"output": {
                    "sentence": {"sentence_id": 1, "text": self.plan.transcript, "sentence_end": True}}}})
                self.queue.put_nowait({"header": {"event": "task-finished"}, "payload": {"usage": {
                    "duration": math.ceil(self.audio_bytes / 32000)}}})
        elif kind == "session.update":
            self.queue.put_nowait({"type": "session.updated"})
        elif kind == "session.finish":
            if self.plan.fault == "tts_fail":
                self.queue.put_nowait({"type": "error"})
                return
            # Soft synthetic tone: exercises real PCM decode/playback, not a TTS voice claim.
            frames = int(self.plan.audio_seconds * 24000)
            pcm = b"".join(struct.pack("<h", round(180 * math.sin(2 * math.pi * 220 * i / 24000))) for i in range(frames))
            for offset in range(0, len(pcm), 9600):
                self.queue.put_nowait({"type": "response.audio.delta", "delta": base64.b64encode(pcm[offset:offset + 9600]).decode()})
                if self.plan.fault == "tts_disconnect":
                    self.queue.put_nowait(ConnectionError("simulated TTS disconnect"))
                    return
            self.queue.put_nowait({"type": "response.done", "response": {"usage": {"output_tokens": 10}}})
            self.queue.put_nowait({"type": "session.finished"})

    async def recv(self):
        value = await self.queue.get()
        await asyncio.sleep((self.plan.asr_delay_ms if self.role == "asr" else self.plan.tts_delay_ms) / 1000)
        if isinstance(value, Exception):
            raise value
        return json.dumps(value)


class SSE(httpx.AsyncByteStream):
    def __init__(self):
        self.plan = copy.deepcopy(scenario)

    async def __aiter__(self):
        active["llm"] += 1
        record("llm", "open")
        try:
            if self.plan.fault == "llm_timeout":
                # A model read timeout, not a wall-clock wait; runs deterministically and without a network.
                raise httpx.ReadTimeout("simulated upstream timeout")
            for offset in range(0, len(self.plan.answer), 4):
                await asyncio.sleep(self.plan.llm_delay_ms / 1000)
                yield ("data: " + json.dumps({"choices": [{"delta": {"content": self.plan.answer[offset:offset + 4]}}]}) + "\n\n").encode()
                if self.plan.fault == "llm_disconnect":
                    raise httpx.ReadError("simulated upstream disconnect")
            yield b'data: {"choices": [], "usage": {"prompt_tokens": 200, "completion_tokens": 40}}\n\n'
            yield b'data: [DONE]\n\n'
        finally:
            active["llm"] -= 1
            record("llm", "close")


class SimASR(QwenASR):
    def __init__(self, settings, factory, lesson_id):
        super().__init__(settings, factory, lesson_id, connector=lambda *args, **kwargs: Socket("asr"))


class SimTTS(QwenTTS):
    def __init__(self, settings, factory, lesson_id):
        super().__init__(settings, factory, lesson_id, connector=lambda *args, **kwargs: Socket("tts"))


class SimLLM(QwenLLM):
    def __init__(self, settings, on_delta, transport=None):
        def response(request):
            body = json.loads(request.content)
            assert body["stream"] is True
            record("llm", "request", has_voice_context="语音播放回执" in str(body["messages"]))
            return httpx.Response(200, stream=SSE(), headers={"content-type": "text/event-stream"})
        super().__init__(settings, on_delta, httpx.MockTransport(response))


# Deliberately process-local patch inside tests/, no production environment switch.
voice_session.QwenASR, voice_session.QwenTTS, voice_session.QwenLLM = SimASR, SimTTS, SimLLM
settings = Settings(_env_file=None, data_dir=Path("data/e2e/voice-sim"), model_mode="demo",
                    fast_api_key="", reasoning_api_key="", vision_api_key="", desktop_token="",
                    voice_enabled=True, voice_api_key="simulation-not-a-key", voice_workspace="",
                    voice_input_cny=.15, voice_output_cny=1.5, voice_asr_cny_second=.00033,
                    voice_tts_cny_10k=1, voice_cny_to_gbp=.12, request_timeout=45,
                    allowed_origins="http://127.0.0.1:3100", voice_session_seconds=1800)
app = create_app(settings)


@app.post("/__simulation/scenario")
async def choose(body: Scenario):
    global scenario
    scenario = body
    if not app.state.voice_sessions:
        trace.clear()
    record("simulation", "scenario", fault=body.fault)
    return {"simulation": True, "paid_calls": 0}


@app.get("/__simulation/state")
async def state():
    return {"simulation": True, "paid_calls": 0, "active": active,
            "sessions": len(app.state.voice_sessions), "events": trace}


@app.post("/__simulation/disconnect")
async def disconnect():
    sessions = list(app.state.voice_sessions.values())
    for session in sessions:
        await session.close()
    return {"simulation": True}


@app.post("/__simulation/late/{lesson_id}")
async def late(lesson_id: str):
    session = app.state.voice_sessions.get(lesson_id)
    if not session:
        raise HTTPException(404)
    # Inject stale events across a genuine local WebSocket to test the client's turn guard.
    for kind, data in [("text", {"delta": "SIM_STALE_SHOULD_NOT_APPEAR"}),
                       ("segment", {"segment_id": "late", "text": "stale"}),
                       ("audio", {"segment_id": "late", "pcm": base64.b64encode(bytes(4800)).decode()})]:
        await session.send(kind, turn_id="cancelled-simulation-turn", **data)
    return {"simulation": True}
