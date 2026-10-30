"""Authenticated, bounded local voice sessions integrated with the existing lesson transaction."""
import asyncio
import base64
import contextlib
import json
import secrets
import time
from collections import OrderedDict

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from .db import Event, Lesson, Teacher, uid
from .llm import ModelError
from .qwen_voice import QwenASR, QwenLLM, QwenTTS, configuration
from .service import public_lesson, turn
from .voice import (
    SentenceBuffer,
    chapter_terms,
    classify_interruption,
    needs_math_confirmation,
    spoken_math,
    whiteboard_text,
)


class VoiceSession:
    def __init__(self, ws, lesson_id, settings, factory, lock, transport=None):
        self.ws, self.lesson_id, self.s, self.factory, self.lock = ws, lesson_id, settings, factory, lock
        self.transport = transport
        self.reply = self.recognition = None
        self.audio = None
        self.utterance = ""
        self.turn_id = ""
        self.gate = asyncio.Event()
        self.gate.set()
        self.segments = OrderedDict()
        self.heard = []
        self.interrupted = None
        self.closed = False
        self.audio_bytes = 0
        self.started = time.monotonic()
        self.last_begin = 0.0
        self.pending_confirmation = None
        self.asr_factory, self.tts_factory, self.llm_factory = QwenASR, QwenTTS, QwenLLM
        with factory() as db:
            events = list(db.scalars(select(Event).where(Event.lesson_id == lesson_id).order_by(Event.created_at.desc()).limit(50)))
            self.heard = [e.data for e in reversed(events) if e.data.get("type") == "voice_playback"][-8:]

    async def send(self, kind, **data):
        if not self.closed:
            await asyncio.wait_for(self.ws.send_json({"type": kind, **data}), 5)

    async def cancel_reply(self):
        old, self.turn_id = self.turn_id, ""
        self.gate.set()
        if self.reply:
            self.reply.cancel()
            await asyncio.gather(self.reply, return_exceptions=True)
            self.reply = None
        if old:
            await self.send("cancelled", turn_id=old)

    async def close(self):
        self.closed = True
        self.turn_id = ""
        self.gate.set()
        tasks = [t for t in [self.reply, self.recognition] if t]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.audio = None
        with contextlib.suppress(Exception):
            await self.ws.close()

    def receipt(self, message):
        key = (message.get("turn_id"), message.get("segment_id"))
        segment = self.segments.get(key)
        status = message.get("status")
        if not segment or status not in {"completed", "interrupted"}:
            return
        if segment.get("completed"):
            return
        elapsed = message.get("elapsed_ms", 0)
        if not isinstance(elapsed, (int, float)) or not 0 <= elapsed <= 120000:
            return
        data = {"type": "voice_playback", "turn_id": key[0], "segment_id": key[1],
                "text": segment["text"], "status": status, "elapsed_ms": round(elapsed),
                "alignment": "approximate_segment_boundary", "source": "client_playback_receipt"}
        if status == "completed":
            segment["completed"] = True
            if self.interrupted and (self.interrupted["turn_id"], self.interrupted["segment_id"]) == key:
                self.interrupted = None
            self.heard = (self.heard + [data])[-8:]
        else:
            self.interrupted = data
        with self.factory() as db:
            db.add(Event(lesson_id=self.lesson_id, data={**data, "text": data["text"] if self.s.retain_transcripts else None}))
            db.commit()

    def context(self, row, text):
        # Existing explicit visual observation + bounded visible whiteboard text, not invented handwriting recognition.
        board = row.data.get("board") or {}
        board_text = whiteboard_text(board)
        return {"new_question": text[:500], "current_exercise": public_lesson(row).get("current_exercise"),
                "teaching_step": row.data["state"],
                "interrupted_at": {**self.interrupted, "text": self.interrupted["text"][:240]} if self.interrupted else None,
                "heard_completed": [{**h, "text": (h.get("text") or "")[:200]} for h in self.heard[-2:]],
                "whiteboard_text": board_text[:2],
                "whiteboard_observation": str(row.data.get("observation") or "")[:300],
                "note": "近似句段边界，不是逐字对齐或掌握证据。生成文本不等于听过。"}

    async def respond(self, text, event="message", source="typed"):
        await self.cancel_reply()
        rid = self.turn_id = uid()
        await self.send("turn", turn_id=rid)

        async def work():
            queue = asyncio.Queue(maxsize=6)
            buffer, index = SentenceBuffer(), 0

            async def sentence(value):
                nonlocal index
                index += 1
                sid = str(index)
                self.segments[(rid, sid)] = {"text": value, "completed": False}
                while len(self.segments) > 100:
                    self.segments.popitem(last=False)
                await queue.put((sid, value))

            async def delta(value):
                await self.gate.wait()
                if rid != self.turn_id:
                    raise asyncio.CancelledError()
                await self.send("text", turn_id=rid, delta=value)
                for value in buffer.feed(value):
                    await sentence(value)

            async def synthesize():
                tts = self.tts_factory(self.s, self.factory, self.lesson_id)
                failed = False
                while item := await queue.get():
                    if failed:
                        continue
                    sid, value = item
                    await self.gate.wait()
                    if rid != self.turn_id:
                        return
                    await self.send("segment", turn_id=rid, segment_id=sid, text=value)
                    try:
                        async for chunk in tts.speak(spoken_math(value)):
                            await self.gate.wait()
                            if rid != self.turn_id:
                                return
                            await self.send("audio", turn_id=rid, segment_id=sid,
                                            pcm=base64.b64encode(chunk).decode(), sample_rate=24000)
                        await self.send("segment_end", turn_id=rid, segment_id=sid)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        failed = True
                        await self.send("tts_error", turn_id=rid, segment_id=sid,
                                        message="语音合成失败，文字仍可阅读；未自动重试，可能产生的费用预留已保留。")

            synth = asyncio.create_task(synthesize())
            try:
                async with self.lock:
                    with self.factory() as db:
                        row = db.get(Lesson, self.lesson_id)
                        if not row or row.data["state"] == "SESSION_SUMMARY":
                            return
                        gateway = self.llm_factory(self.s, delta, self.transport)
                        async with asyncio.timeout(self.s.request_timeout + 15):
                            result = await turn(db, row, db.get(Teacher, row.teacher_id), gateway, text, event,
                                                voice_context={**self.context(row, text), "input_source": source})
                        # Control-only responses do not call the LLM but still need display/speech.
                        if result.get("decision") and not index and not buffer.pending and result["lesson"].get("messages"):
                            last = result["lesson"]["messages"][-1]
                            if last["role"] == "assistant":
                                await delta(last["content"])
                        if result.get("decision") and row.data.get("messages") and row.data["messages"][-1]["role"] == "assistant":
                            updated = dict(row.data)
                            updated["messages"] = [*updated["messages"][:-1],
                                {**updated["messages"][-1], "delivery": "voice_generated_not_confirmed", "turn_id": rid}]
                            row.data = updated
                            db.commit()
                            result["lesson"] = public_lesson(row)
                    await self.send("result", turn_id=rid, result=result)
                for value in buffer.feed("", final=True):
                    await sentence(value)
                await queue.put(None)
                await synth
                if rid == self.turn_id:
                    await self.send("turn_end", turn_id=rid)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if rid == self.turn_id:
                    await self.send("error", message=exc.message if isinstance(exc, ModelError)
                                    else "语音回复失败或超时，未重试；可能产生的费用预留已保留。")
            finally:
                synth.cancel()
                await asyncio.gather(synth, return_exceptions=True)

        self.reply = asyncio.create_task(work())

    async def recognize(self, utterance, queue):
        final = {}
        saw_text = False
        try:
            with self.factory() as db:
                row = db.get(Lesson, self.lesson_id)
                terms = chapter_terms(row.data.get("topic_index", 0))
            async def frames():
                while (chunk := await queue.get()) is not None:
                    yield chunk
            asr = self.asr_factory(self.s, self.factory, self.lesson_id)
            async for part in asr.transcribe(frames(), terms):
                if utterance != self.utterance:
                    return
                saw_text = saw_text or bool(part.text.strip())
                if part.final:
                    final[part.sentence_id] = part.text
                await self.send("transcript", utterance_id=utterance, text=part.text, final=part.final)
            if utterance != self.utterance:
                return
            if saw_text and not final:
                raise ValueError("ASR completed without final transcript")
            text = "".join(final[k] for k in sorted(final))[:4000]
            kind = classify_interruption(text)
            await self.send("recognized", utterance_id=utterance, text=text, disposition=kind)
            with self.factory() as db:
                db.add(Event(lesson_id=self.lesson_id, data={"type": "voice_transcript", "raw_text": text if self.s.retain_transcripts else None,
                       "utterance_id": utterance, "disposition": kind}))
                db.commit()
            if kind in {"ack", "noise"}:
                self.gate.set()
                await self.send("resume", utterance_id=utterance, turn_id=self.turn_id)
            elif needs_math_confirmation(text):
                await self.cancel_reply()
                self.pending_confirmation = (utterance, text)
                await self.send("confirmation", utterance_id=utterance, text=text,
                                message="这句包含容易听错的数学符号或术语，请确认原话，或修改转写后发送。")
            else:
                await self.respond(text, source="microphone")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", message=exc.message if isinstance(exc, ModelError)
                            else "语音识别失败或连接中断。老师保持暂停，请重试或打字；费用预留已保留。")

    async def run(self):
        await self.send("ready", max_utterance_seconds=self.s.voice_utterance_seconds)
        async with asyncio.timeout(self.s.voice_session_seconds):
            while True:
                message = await self.ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    chunk = message["bytes"]
                    self.audio_bytes += len(chunk)
                    if len(chunk) > 16000 or len(chunk) % 2 or self.audio_bytes > 32000 * self.s.voice_session_seconds:
                        raise ValueError("audio limit")
                    # Also prevent accelerated uploads creating unbounded paid requests.
                    if self.audio_bytes > 32000 * (time.monotonic() - self.started + 5):
                        raise ValueError("audio rate")
                    if self.audio is not None:
                        self.audio.put_nowait(chunk)
                    continue
                raw = message.get("text", "")
                if len(raw) > 12000:
                    raise ValueError("message limit")
                body = json.loads(raw)
                kind = body.get("type")
                if kind == "begin":
                    if time.monotonic() - self.last_begin < .35:
                        raise ValueError("utterance rate")
                    self.last_begin = time.monotonic()
                    self.pending_confirmation = None
                    self.gate.clear()
                    if self.recognition:
                        self.recognition.cancel()
                        await asyncio.gather(self.recognition, return_exceptions=True)
                    self.utterance = str(body.get("utterance_id", ""))[:80]
                    self.audio = asyncio.Queue(maxsize=256)
                    self.recognition = asyncio.create_task(self.recognize(self.utterance, self.audio))
                elif kind == "audio_end":
                    if self.audio is not None:
                        self.audio.put_nowait(None)
                        self.audio = None
                elif kind == "pause":
                    self.gate.clear()
                elif kind == "resume":
                    self.gate.set()
                    await self.send("resume", turn_id=self.turn_id)
                elif kind == "stop":
                    await self.cancel_reply()
                elif kind == "played":
                    self.receipt(body)
                elif kind == "confirm":
                    if self.pending_confirmation and body.get("utterance_id") == self.pending_confirmation[0]:
                        _, text = self.pending_confirmation
                        self.pending_confirmation = None
                        await self.respond(text, source="microphone")
                elif kind == "text":
                    self.pending_confirmation = None
                    text = str(body.get("text", ""))[:4000].strip()
                    event = body.get("event", "message")
                    if event not in {"message", "hint", "reexplain", "topic", "auto", "pause", "resume", "end"}:
                        raise ValueError("invalid event")
                    # Invalidate pending ASR when the user submits a typed correction.
                    self.utterance = ""
                    if self.recognition:
                        self.recognition.cancel()
                        await asyncio.gather(self.recognition, return_exceptions=True)
                    self.audio = None
                    await self.respond(text, event)
                elif kind == "end":
                    break
                else:
                    raise ValueError("invalid voice command")


def install_voice(app, settings, factory, lock, transport=None):
    tickets, sessions = {}, {}
    origins = settings.allowed_origins.split(",")
    app.state.voice_sessions = sessions

    @app.get("/api/voice/config")
    def voice_config():
        return configuration(settings)

    @app.post("/api/lessons/{lesson_id}/voice-ticket")
    async def ticket(lesson_id: str, request: Request):
        origin = request.headers.get("origin")
        if origin not in origins:
            raise HTTPException(403, "语音连接需要受信任的页面来源。")
        missing = configuration(settings)["missing"]
        if missing:
            raise HTTPException(409, "请先配置：" + "、".join(missing))
        with factory() as db:
            row = db.get(Lesson, lesson_id)
            if not row or row.data["state"] == "SESSION_SUMMARY":
                raise HTTPException(404, "课堂不存在或已结束。")
        for key, value in list(tickets.items()):
            if value[2] < time.monotonic():
                tickets.pop(key, None)
        if len(tickets) >= 32:
            raise HTTPException(429, "语音连接请求过多。")
        token = secrets.token_urlsafe(32)
        tickets[token] = (lesson_id, origin, time.monotonic() + 30)
        return {"ticket": token, "expires_in": 30}

    @app.websocket("/api/lessons/{lesson_id}/voice")
    async def voice_socket(ws: WebSocket, lesson_id: str):
        # HTTP middleware does NOT protect WebSockets. Validate origin, one-use identity ticket,
        # lesson binding and expiry here. Ticket is sent in first frame, never URLs/logs.
        if ws.headers.get("origin") not in origins:
            await ws.close(code=4403)
            return
        await ws.accept()
        session = None
        try:
            auth_raw = await asyncio.wait_for(ws.receive_text(), 5)
            if len(auth_raw) > 512:
                raise ValueError("auth size")
            auth = json.loads(auth_raw)
            identity = tickets.pop(auth.get("ticket", ""), None)
            if not identity or identity[:2] != (lesson_id, ws.headers.get("origin")) or identity[2] < time.monotonic():
                await ws.close(code=4401)
                return
            with factory() as db:
                row = db.get(Lesson, lesson_id)
                if not row or row.data["state"] == "SESSION_SUMMARY":
                    await ws.close(code=4404)
                    return
            if sessions:  # One microphone/classroom per local instance.
                await ws.close(code=4409)
                return
            session = VoiceSession(ws, lesson_id, settings, factory, lock, transport)
            sessions[lesson_id] = session
            await session.run()
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception:
            if session:
                with contextlib.suppress(Exception):
                    await session.send("error", message="语音连接已结束（超时、网络或输入限制），请重新开始。")
            else:
                with contextlib.suppress(Exception):
                    await ws.close(code=4401)
        finally:
            if session:
                await session.close()
                sessions.pop(lesson_id, None)

    return sessions
