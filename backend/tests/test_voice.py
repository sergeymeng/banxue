import asyncio
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.db import Event, Knowledge, Lesson, Teacher, Usage
from app.main import create_app
from app.qwen_voice import QwenASR, QwenLLM, QwenTTS, VoiceSettings, configuration, endpoints
from app.service import new_lesson
from app.voice import SentenceBuffer, chapter_terms, classify_interruption, spoken_math
from app.voice_session import VoiceSession


def settings(tmp_path, **extra):
    return Settings(_env_file=None, data_dir=tmp_path, voice_enabled=True, voice_api_key="test-only-secret",
                    voice_input_cny=.15, voice_output_cny=1.5, voice_asr_cny_second=.00033,
                    voice_tts_cny_10k=1, voice_cny_to_gbp=.12, **extra)


def setup(tmp_path, **extra):
    s = settings(tmp_path, **extra)
    app = create_app(s)
    with app.state.factory() as db:
        teacher = Teacher(data={"name": "Test", "language": "中文"})
        db.add(teacher)
        db.commit()
        lesson = new_lesson(db, teacher.id, "policy")
        return s, app, lesson.id


def test_voice_auth_origin_ticket_binding_and_replay(tmp_path):
    s, app, lid = setup(tmp_path, desktop_token="desktop-secret")
    path = f"/api/lessons/{lid}"
    with TestClient(app) as client:
        assert client.post(path + "/voice-ticket", headers={"origin": "http://localhost:3000"}).status_code == 401
        headers = {"x-desktop-token": "desktop-secret", "origin": "http://localhost:3000"}
        assert client.post(path + "/voice-ticket", headers={**headers, "origin": "https://evil.test"}).status_code == 403
        assert client.post(path + "/voice-ticket", headers={"x-desktop-token": "desktop-secret"}).status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path + "/voice", headers={"origin": "https://evil.test"}):
                pass
        with client.websocket_connect(path + "/voice", headers={"origin": headers["origin"]}) as ws:
            ws.send_json({"ticket": "wrong"})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4401
        token = client.post(path + "/voice-ticket", headers=headers).json()["ticket"]
        with client.websocket_connect(path + "/voice", headers={"origin": headers["origin"]}) as ws:
            ws.send_json({"ticket": token})
            assert ws.receive_json()["type"] == "ready"
            assert client.post(path + "/turn", json={"text": "hello"}, headers=headers).status_code == 409
            ws.send_json({"type": "end"})
        with client.websocket_connect(path + "/voice", headers={"origin": headers["origin"]}) as ws:
            ws.send_json({"ticket": token})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        other = client.post(path + "/voice-ticket", headers=headers).json()["ticket"]
        with client.websocket_connect("/api/lessons/not-the-lesson/voice", headers={"origin": headers["origin"]}) as ws:
            ws.send_json({"ticket": other})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        assert "test-only-secret" not in client.get("/api/voice/config", headers=headers).text
        assert not app.state.voice_sessions


def test_missing_prices_and_key_are_not_zero(tmp_path):
    s = Settings(_env_file=None, data_dir=tmp_path)
    assert len(configuration(s)["missing"]) >= 6
    assert endpoints(s)["asr"].endswith("/inference")
    assert endpoints(s)["tts"].endswith("/realtime")
    s.voice_region = "singapore"
    s.voice_workspace = "workspace123"
    assert "workspace123.ap-southeast-1.maas.aliyuncs.com" in endpoints(s)["llm"]


def test_math_and_short_interjections_are_conservative():
    for text in ["嗯。", "对", "OK", "嗯嗯"]:
        assert classify_interruption(text) == "ack"
    for text in ["等一下", "为什么", "我没懂", "嗯，但是为什么", "倒数", "负 x 的二次方"]:
        assert classify_interruption(text) == "question"
    assert classify_interruption(" ") == "noise"
    assert "倒数" in chapter_terms(0) and "chain rule" in chapter_terms(0)
    assert "product rule" in chapter_terms(1)
    assert spoken_math("-x-1") == "负x减1"
    assert spoken_math(r"$x^2 + \frac{1}{x}$") == "x的2次方 加 x分之1"
    assert "\\" not in spoken_math(r"\unknown{x}")
    buffer = SentenceBuffer()
    assert buffer.feed("数值 1.2") == []
    assert buffer.feed("。用 chain rule！") == ["数值 1.2。", "用 chain rule！"]


class ProviderSocket:
    def __init__(self, tts=False, block=False):
        self.events = asyncio.Queue()
        self.sent, self.closed, self.tts, self.block = [], False, tts, block

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def send(self, value):
        self.sent.append(value)
        if isinstance(value, bytes):
            return
        body = json.loads(value)
        kind = body.get("type") or body.get("header", {}).get("action")
        if kind == "run-task":
            self.events.put_nowait({"header": {"event": "task-started"}})
        if kind == "finish-task" and not self.block:
            self.events.put_nowait({"header": {"event": "result-generated"}, "payload": {"output": {
                "sentence": {"text": "chain rule 和倒数", "sentence_end": True, "sentence_id": 1}}}})
            self.events.put_nowait({"header": {"event": "task-finished"}, "payload": {"usage": {"duration": 1}}})
        if kind == "session.update":
            self.events.put_nowait({"type": "session.updated"})
        if kind == "session.finish" and not self.block:
            self.events.put_nowait({"type": "response.audio.delta", "delta": base64.b64encode(b"\x00\x00" * 240).decode()})
            self.events.put_nowait({"type": "response.done", "response": {"usage": {"output_tokens": 2}}})
            self.events.put_nowait({"type": "session.finished"})

    async def recv(self):
        return json.dumps(await self.events.get())


async def frames():
    yield b"\x00\x00" * 160


async def test_asr_adapter_hotwords_binary_and_provider_duration(tmp_path):
    s, app, lid = setup(tmp_path)
    socket = ProviderSocket()
    adapter = QwenASR(s, app.state.factory, lid, lambda *a, **kw: socket)
    out = [part async for part in adapter.transcribe(frames(), chapter_terms(0))]
    assert out[0].text == "chain rule 和倒数" and socket.closed
    config = json.loads(socket.sent[0])["payload"]
    assert config["parameters"]["vocabulary"]["倒数"] == 3
    assert config["parameters"]["max_sentence_silence"] == 1400
    assert isinstance(socket.sent[1], bytes)
    with app.state.factory() as db:
        charge = db.scalars(select(Usage)).one()
        assert charge.data["usage_source"] == "provider"
        assert charge.charged_gbp == pytest.approx(.00033 * .12)


async def test_tts_stream_protocol_and_cancel_retains_reservation(tmp_path):
    s, app, lid = setup(tmp_path)
    socket = ProviderSocket(tts=True)
    adapter = QwenTTS(s, app.state.factory, lid, lambda *a, **kw: socket)
    assert len([audio async for audio in adapter.speak("为什么？")]) == 1
    assert [json.loads(v)["type"] for v in socket.sent] == ["session.update", "input_text_buffer.append", "input_text_buffer.commit", "session.finish"]
    block = ProviderSocket(tts=True, block=True)
    adapter = QwenTTS(s, app.state.factory, lid, lambda *a, **kw: block)
    async def consume():
        async for _ in adapter.speak("未播放的句子"):
            pass
    task = asyncio.create_task(consume())
    await asyncio.sleep(.02)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert block.closed
    with app.state.factory() as db:
        rows = list(db.scalars(select(Usage)))
        assert rows[-1].data["status"] == "uncertain" and rows[-1].charged_gbp > 0
        assert rows[0].data["actual_usage"] == {"output_tokens": 2}


async def test_asr_cancel_retains_full_reservation(tmp_path):
    s, app, lid = setup(tmp_path)
    socket = ProviderSocket(block=True)
    adapter = QwenASR(s, app.state.factory, lid, lambda *a, **kw: socket)
    async def consume():
        async for _ in adapter.transcribe(frames(), []):
            pass
    task = asyncio.create_task(consume())
    await asyncio.sleep(.02)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    with app.state.factory() as db:
        row = db.scalars(select(Usage)).one()
        assert row.data["status"] == "uncertain"
        assert row.charged_gbp == pytest.approx(60 * .00033 * .12)
    assert socket.closed


async def test_real_gateway_sse_transport_contract_and_secret_redaction(tmp_path):
    s, app, lid = setup(tmp_path)
    seen, deltas = [], []
    def handler(request):
        seen.append(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer test-only-secret"
        data = [{"choices": [{"delta": {"content": "先看"}}]}, {"choices": [{"delta": {"content": "内层。"}}]},
                {"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": 8}}]
        return httpx.Response(200, text="".join("data: " + json.dumps(d) + "\n\n" for d in data) + "data: [DONE]\n\n")
    async def delta(text):
        deltas.append(text)
    adapter = QwenLLM(s, delta, httpx.MockTransport(handler))
    with app.state.factory() as db:
        answer = await adapter.complete(db, lid, "fast", [{"role": "user", "content": "为什么"}])
        assert answer == "先看内层。" and deltas == ["先看", "内层。"]
        row = db.scalars(select(Usage)).one()
        assert row.data["usage_source"] == "provider"
        assert "test-only-secret" not in json.dumps(row.data)
    assert seen[0]["stream"] and seen[0]["enable_thinking"] is False


class ClientSocket:
    def __init__(self):
        self.events = []
        self.closed = False

    async def send_json(self, data):
        self.events.append(data)

    async def close(self):
        self.closed = True


async def test_repeated_interruption_context_receipts_and_cleanup(tmp_path):
    s, app, lid = setup(tmp_path)
    ws = ClientSocket()
    session = VoiceSession(ws, lid, s, app.state.factory, asyncio.Lock())
    contexts = []
    class LLM:
        def __init__(self, settings, delta, transport):
            self.settings = VoiceSettings(settings)
            self.delta = delta
        async def complete(self, db, lesson, role, messages, **kwargs):
            contexts.append(messages)
            await self.delta("先求外层导数。")
            await asyncio.sleep(.04)
            await self.delta("再乘以内层导数。")
            return "先求外层导数。再乘以内层导数。"
    class TTS:
        def __init__(self, *args):
            pass
        async def speak(self, text):
            yield b"\0\0" * 240
            await asyncio.sleep(.03)
    session.llm_factory, session.tts_factory = LLM, TTS
    await session.respond("为什么", source="microphone")
    first = session.turn_id
    await asyncio.sleep(.02)
    session.receipt({"turn_id": first, "segment_id": "1", "status": "interrupted", "elapsed_ms": 8})
    await session.respond("等一下", source="microphone")
    second = session.turn_id
    await asyncio.sleep(.01)
    await session.respond("我没懂", source="microphone")
    third = session.turn_id
    assert len({first, second, third}) == 3
    await session.reply
    index = next(i for i, e in enumerate(ws.events) if e["type"] == "turn" and e["turn_id"] == third)
    assert all(e.get("turn_id") not in {first, second} for e in ws.events[index:])
    assert "approximate_segment_boundary" in json.dumps(contexts[-1])
    session.receipt({"turn_id": third, "segment_id": "1", "status": "completed", "elapsed_ms": 10})
    await session.close()
    assert ws.closed and session.reply.done()
    with app.state.factory() as db:
        assert not list(db.scalars(select(Knowledge)))
        receipts = [e.data for e in db.scalars(select(Event)) if e.data["type"] == "voice_playback"]
        assert len(receipts) == 2
        assert receipts[0]["status"] == "interrupted"
        lesson = db.get(Lesson, lid)
        assert not lesson.data["last_decision"]["auto"]

async def test_noise_and_ack_resume_without_new_llm_or_evidence(tmp_path):
    from app.voice import Transcript
    s, app, lid = setup(tmp_path)
    for text in ["", "嗯。", "对"]:
        ws = ClientSocket()
        session = VoiceSession(ws, lid, s, app.state.factory, asyncio.Lock())
        session.turn_id, session.utterance = "still-current", "u1"
        session.gate.clear()
        class ASR:
            def __init__(self, *args):
                pass
            async def transcribe(self, audio, terms):
                async for _ in audio:
                    pass
                yield Transcript(text, True, 1)
        session.asr_factory = ASR
        queue = asyncio.Queue()
        queue.put_nowait(None)
        await session.recognize("u1", queue)
        assert session.gate.is_set() and session.reply is None
        assert ws.events[-1] == {"type": "resume", "utterance_id": "u1", "turn_id": "still-current"}
        await session.close()
    with app.state.factory() as db:
        assert not list(db.scalars(select(Knowledge)))
        assert not list(db.scalars(select(Usage)))


async def test_truncated_llm_sse_keeps_cost_and_never_retries(tmp_path):
    from app.llm import ModelError
    s, app, lid = setup(tmp_path)
    count = 0
    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"半句话"}}]}\n\n')
    async def delta(value):
        pass
    adapter = QwenLLM(s, delta, httpx.MockTransport(handler))
    with app.state.factory() as db:
        with pytest.raises(ModelError):
            await adapter.complete(db, lid, "fast", [{"role": "user", "content": "为什么"}])
        row = db.scalars(select(Usage)).one()
        assert row.charged_gbp > 0 and row.data["status"] == "uncertain"
    assert count == 1


async def test_audio_budget_blocks_before_provider_connection(tmp_path):
    from app.llm import ModelError
    s, app, lid = setup(tmp_path, request_budget_gbp=.000001)
    calls = []
    def connect(*args, **kwargs):
        calls.append(args)
        return ProviderSocket()
    with pytest.raises(ModelError) as exc:
        async for _ in QwenASR(s, app.state.factory, lid, connect).transcribe(frames(), []):
            pass
    assert exc.value.code == "budget_exceeded" and not calls

async def test_spoken_math_requires_confirmation_before_generation(tmp_path):
    from app.voice import Transcript, needs_math_confirmation
    assert needs_math_confirmation("负 x 的二次方")
    assert needs_math_confirmation("倒数")
    assert needs_math_confirmation("negative x squared")
    assert not needs_math_confirmation("为什么用 chain rule")
    s, app, lid = setup(tmp_path)
    ws = ClientSocket()
    session = VoiceSession(ws, lid, s, app.state.factory, asyncio.Lock())
    session.utterance = "math1"
    class ASR:
        def __init__(self, *args):
            pass
        async def transcribe(self, audio, terms):
            yield Transcript("负 x 的二次方", True, 1)
    session.asr_factory = ASR
    await session.recognize("math1", asyncio.Queue())
    assert session.reply is None
    assert session.pending_confirmation == ("math1", "负 x 的二次方")
    assert ws.events[-1]["type"] == "confirmation"
    await session.close()


def test_tldraw_rich_text_context_does_not_claim_to_recognize_strokes():
    from app.voice import whiteboard_text
    snapshot = {"document": {"store": {
        "shape:1": {"type": "text", "props": {"richText": {"content": [{"content": [{"text": "x squared"}]}]}}},
        "shape:2": {"type": "draw", "props": {"segments": [1, 2]}},
        "shape:3": {"type": "note", "meta": {"author": "teacher"}, "props": {"richText": {"content": [{"text": "chain rule"}]}}},
    }}}
    assert whiteboard_text(snapshot) == [{"text": "x squared", "source": "typed_board_text"}, {"text": "chain rule", "source": "teacher_note"}]

async def test_inapplicable_voice_auto_does_not_replay_old_answer(tmp_path):
    s, app, lid = setup(tmp_path)
    ws = ClientSocket()
    session = VoiceSession(ws, lid, s, app.state.factory, asyncio.Lock())
    await session.respond("", "auto")  # ONBOARDING cannot auto advance.
    await session.reply
    assert not [e for e in ws.events if e["type"] in {"text", "segment", "audio"}]
    with app.state.factory() as db:
        assert not list(db.scalars(select(Usage)))
        assert "delivery" not in db.get(Lesson, lid).data["messages"][-1]
    await session.close()
