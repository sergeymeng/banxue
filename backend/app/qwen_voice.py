"""Alibaba adapters. Protocol/endpoint details stay out of classroom orchestration.
Verified 2026-10-30; see docs/QWEN_VOICE.md for official sources and price scope.
"""
import asyncio
import base64
import json
import re
import uuid
from urllib.parse import urlencode

from websockets.asyncio.client import connect

from .llm import Gateway
from .voice import Transcript
from .voice_cost import AudioCharge

PRESETS = {
    "beijing": {"input_cny": .15, "output_cny": 1.5, "asr_cny_second": .00033, "tts_cny_10k": 1.0},
    "singapore": {"input_cny": .367, "output_cny": 2.936, "asr_cny_second": .00066, "tts_cny_10k": .954101},
}
MODELS = {"llm_model": "qwen-flash", "asr_model": "qwen-audio-3.0-asr-flash-streaming",
          "tts_model": "qwen3-tts-flash-realtime", "voice": "Cherry"}


def configuration(settings):
    missing = []
    if not settings.voice_enabled:
        missing.append("在设置中启用千问云端")
    if not settings.voice_api_key:
        missing.append("千问 API Key")
    for key in ["input_cny", "output_cny", "asr_cny_second", "tts_cny_10k", "cny_to_gbp"]:
        if getattr(settings, "voice_" + key) is None:
            missing.append("费用配置：" + key)
    if settings.voice_workspace and not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", settings.voice_workspace):
        missing.append("有效的业务空间 ID")
    # Model changes are allowed within these protocol/billing families. Other families need another adapter.
    for field, prefix in [("asr_model", "qwen-audio-3.0-asr-flash-streaming"),
                          ("tts_model", "qwen3-tts-flash-realtime")]:
        if not getattr(settings, "voice_" + field).startswith(prefix):
            missing.append("支持的协议/计费模型：" + prefix)
    return {"enabled": settings.voice_enabled, "region": settings.voice_region, "missing": missing,
            "presets": {k: {**MODELS, **v} for k, v in PRESETS.items()}, "price_date": "2026-10-30",
            "currency": "CNY", "has_key": bool(settings.voice_api_key)}


def endpoints(s):
    if s.voice_workspace:
        area = "cn-beijing" if s.voice_region == "beijing" else "ap-southeast-1"
        host = f"{s.voice_workspace}.{area}.maas.aliyuncs.com"
    else:
        host = "dashscope.aliyuncs.com" if s.voice_region == "beijing" else "dashscope-intl.aliyuncs.com"
    return {"llm": f"https://{host}/compatible-mode/v1", "asr": f"wss://{host}/api-ws/v1/inference",
            "tts": f"wss://{host}/api-ws/v1/realtime"}


def event(kind, **data):
    return json.dumps({"event_id": uuid.uuid4().hex, "type": kind, **data}, ensure_ascii=False)


class QwenASR:
    def __init__(self, settings, factory, lesson_id, connector=connect):
        self.s, self.factory, self.lesson_id, self.connect = settings, factory, lesson_id, connector

    async def transcribe(self, audio, terms):
        s = self.s
        charge = AudioCharge(self.factory, s, self.lesson_id, "asr", s.voice_asr_model,
                             s.voice_utterance_seconds, s.voice_asr_cny_second, "audio_second")
        task_id, sender, sent = uuid.uuid4().hex, None, 0
        try:
            async with self.connect(endpoints(s)["asr"], additional_headers={"Authorization": "Bearer " + s.voice_api_key},
                                    open_timeout=10, close_timeout=2, max_size=1_000_000) as ws:
                await ws.send(json.dumps({"header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
                    "payload": {"task_group": "audio", "task": "asr", "function": "recognition",
                    "model": s.voice_asr_model, "parameters": {"format": "pcm", "sample_rate": 16000,
                    "max_sentence_silence": 1400, "vocabulary": {word: 3 for word in terms[:12]}}, "input": {}}}))
                ready = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if ready.get("header", {}).get("event") != "task-started":
                    raise ValueError("ASR not ready")

                async def send_audio():
                    nonlocal sent
                    async for chunk in audio:
                        sent += len(chunk)
                        if sent > s.voice_utterance_seconds * 32000:
                            raise ValueError("utterance limit")
                        await ws.send(chunk)
                    await ws.send(json.dumps({"header": {"action": "finish-task", "task_id": task_id,
                                                          "streaming": "duplex"}, "payload": {"input": {}}}))

                sender = asyncio.create_task(send_audio())
                async with asyncio.timeout(s.voice_utterance_seconds + 20):
                    while True:
                        body = json.loads(await ws.recv())
                        kind = body.get("header", {}).get("event")
                        if kind == "task-failed":
                            raise ValueError("ASR failed")
                        if kind == "result-generated":
                            sentence = body.get("payload", {}).get("output", {}).get("sentence", {})
                            if not sentence.get("heartbeat"):
                                yield Transcript(sentence.get("text", "")[:4000], bool(sentence.get("sentence_end")),
                                                 sentence.get("sentence_id", 0))
                        if kind == "task-finished":
                            await sender
                            actual = body.get("payload", {}).get("usage")
                            duration = actual.get("duration") if isinstance(actual, dict) else None
                            charge.finish(units=duration if isinstance(duration, (int, float)) and duration >= 0
                                          else sent / 32000, actual=actual if duration is not None else None)
                            break
        except BaseException:
            charge.finish(status="uncertain")
            raise
        finally:
            if sender:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)


class QwenTTS:
    def __init__(self, settings, factory, lesson_id, connector=connect):
        self.s, self.factory, self.lesson_id, self.connect = settings, factory, lesson_id, connector

    async def speak(self, text):
        s = self.s
        charge = AudioCharge(self.factory, s, self.lesson_id, "tts", s.voice_tts_model,
                             len(text), s.voice_tts_cny_10k / 10000, "input_character")
        try:
            async with asyncio.timeout(s.request_timeout):
                async with self.connect(endpoints(s)["tts"] + "?" + urlencode({"model": s.voice_tts_model}),
                        additional_headers={"Authorization": "Bearer " + s.voice_api_key},
                        open_timeout=10, close_timeout=2, max_size=2_000_000) as ws:
                    await ws.send(event("session.update", session={"voice": s.voice_voice, "mode": "commit",
                        "language_type": "Auto", "response_format": "pcm", "sample_rate": 24000}))
                    while True:
                        body = json.loads(await ws.recv())
                        if body.get("type") == "error":
                            raise ValueError("TTS failed")
                        if body.get("type") == "session.updated":
                            break
                    await ws.send(event("input_text_buffer.append", text=text))
                    await ws.send(event("input_text_buffer.commit"))
                    await ws.send(event("session.finish"))
                    received, actual = 0, None
                    while True:
                        body = json.loads(await ws.recv())
                        kind = body.get("type")
                        if kind == "error":
                            raise ValueError("TTS failed")
                        if kind == "response.audio.delta":
                            chunk = base64.b64decode(body["delta"], validate=True)
                            received += len(chunk)
                            if received > 24000 * 2 * 120 or len(chunk) % 2:
                                raise ValueError("invalid TTS audio")
                            yield chunk
                        if kind == "response.done":
                            actual = body.get("response", {}).get("usage")
                        if kind == "session.finished":
                            if not received:
                                raise ValueError("empty TTS")
                            # Character count is measured locally; raw token usage is not character usage.
                            charge.finish(units=len(text), raw_usage=actual)
                            break
        except BaseException:
            charge.finish(status="uncertain")
            raise


class VoiceSettings:
    """Gateway config view: leaves existing text/vision settings untouched."""
    qwen_voice = True
    model_mode = "live"
    completion_token_field = "max_tokens"

    def __init__(self, settings):
        self.source = settings

    def __getattr__(self, key):
        return getattr(self.source, key)

    def role(self, role):
        s = self.source
        return {"base_url": endpoints(s)["llm"], "model": s.voice_llm_model, "api_key": s.voice_api_key,
                "input_gbp": s.voice_input_cny * s.voice_cny_to_gbp,
                "output_gbp": s.voice_output_cny * s.voice_cny_to_gbp, "cached_gbp": None}


class QwenLLM:
    def __init__(self, settings, on_delta, transport=None):
        self.settings = VoiceSettings(settings)
        self.gateway = Gateway(self.settings, transport)
        self.on_delta = on_delta

    async def complete(self, db, lesson_id, role, messages, *, image=None):
        return await self.gateway.complete(db, lesson_id, role, messages, on_delta=self.on_delta)
