"""Durable image/recognition/review records, isolated from teaching evidence."""

import time

from fastapi import HTTPException
from sqlalchemy import select

from .db import Event, Lesson, Teacher, uid
from .llm import ModelError
from .service import public_lesson, turn
from .vision import Confirmation, ObserveInput, inspect_png


def install_observations(app, settings, factory, lock, gateway, vision, voice_sessions):
    def lesson_record(db, lesson_id):
        row = db.get(Lesson, lesson_id)
        if not row:
            raise HTTPException(404, "课堂不存在。")
        return row

    def record(db, lesson_id, observation_id):
        row = db.get(Event, observation_id)
        if not row or row.lesson_id != lesson_id or row.data.get("type") != "region_observation":
            raise HTTPException(404, "观察记录不存在。")
        return row

    def result(row, observation=None, **extra):
        return {"lesson": public_lesson(row), "sources": [], "observation": observation, **extra}

    @app.get("/api/lessons/{lesson_id}/observations")
    def history(lesson_id: str):
        with factory() as db:
            lesson_record(db, lesson_id)
            return [
                {
                    "id": e.id,
                    "created_at": e.created_at,
                    "source": e.data["observation"]["source"],
                    "status": e.data["status"],
                }
                for e in db.scalars(select(Event).where(Event.lesson_id == lesson_id).order_by(Event.created_at.desc()))
                if e.data.get("type") == "region_observation"
            ]

    @app.get("/api/lessons/{lesson_id}/observations/{observation_id}")
    def detail(lesson_id: str, observation_id: str):
        with factory() as db:
            return record(db, lesson_id, observation_id).data

    @app.post("/api/lessons/{lesson_id}/observe")
    @app.post("/api/lessons/{lesson_id}/observations")
    async def observe(lesson_id: str, body: ObserveInput):
        try:
            image_info = inspect_png(body.image)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        async with lock:
            with factory() as db:
                row = lesson_record(db, lesson_id)
                s = row.data
                if lesson_id in voice_sessions:
                    return {"skipped": "语音课堂中暂缓新的视觉请求；已有白板观察仍用于上下文。"}
                if s.get("paused") or s["state"] == "SESSION_SUMMARY":
                    return {"skipped": "课堂已暂停或结束"}
                if settings.model_mode == "demo":
                    return {"skipped": "离线演示不具备视觉识别。请配置真实 VISION_MODEL；可在消息中提交表达式。"}
                source = body.source.model_dump()
                fingerprint = {
                    "image": image_info["sha256"],
                    "source": source,
                    "lesson_context": {"state": s["state"], "topic_index": s.get("topic_index")},
                }
                if fingerprint == s.get("observed_fingerprint"):
                    existing = record(db, lesson_id, s["latest_observation_id"])
                    return result(
                        row, existing.data.get("reviewed", existing.data["observation"]), skipped="白板没有变化"
                    )
                if time.time() - s.get("last_observed_at", 0) < 20:
                    return {"skipped": "视觉分析冷却中（20 秒）"}
                # Commit request time before the paid call, including timeout/invalid response paths.
                row.data = {**s, "last_observed_at": time.time()}
                db.commit()
                transcription = await vision.recognize(db, lesson_id, body.image)
                oid = uid()
                observation = {
                    "id": oid,
                    "schema_version": 1,
                    **transcription.model_dump(),
                    "source": {**source, **image_info},
                    "provenance": vision.provenance(),
                    "status": "pending",
                    "uncertainty": "unreviewed_transcription; localization_unverified",
                }
                db.add(
                    Event(
                        id=oid,
                        lesson_id=lesson_id,
                        data={
                            "type": "region_observation",
                            "status": "pending",
                            "image": body.image,
                            "observation": observation,
                            "trigger": body.trigger,
                            "lesson_context": {"state": s["state"], "topic_index": s.get("topic_index")},
                        },
                    )
                )
                row.data = {
                    **row.data,
                    "latest_observation_id": oid,
                    "pending_observation_id": oid,
                    "observed_fingerprint": fingerprint,
                }
                db.commit()
                # Pending text and pixels never enter teaching context or trigger a model reply.
                return result(
                    row, observation, decision={"action": "WAIT", "reason": "needs_confirmation", "auto": False}
                )

    @app.post("/api/lessons/{lesson_id}/observations/{observation_id}/discard")
    async def discard(lesson_id: str, observation_id: str):
        async with lock:
            with factory() as db:
                row = lesson_record(db, lesson_id)
                entry = record(db, lesson_id, observation_id)
                if entry.data["status"] == "confirmed":
                    raise HTTPException(409, "已确认记录不能丢弃。")
                entry.data = {**entry.data, "status": "discarded"}
                if row.data.get("pending_observation_id") == observation_id:
                    row.data = {**row.data, "pending_observation_id": None, "observed_fingerprint": None}
                db.commit()
                return result(row)

    @app.post("/api/lessons/{lesson_id}/observations/{observation_id}/confirm")
    async def confirm(lesson_id: str, observation_id: str, body: Confirmation):
        async with lock:
            with factory() as db:
                row = lesson_record(db, lesson_id)
                entry = record(db, lesson_id, observation_id)
                original = entry.data["observation"]
                submitted = body.model_dump()
                if entry.data["status"] == "confirmed":
                    if submitted != entry.data["confirmation"]:
                        raise HTTPException(409, "此记录已确认；请重新选区建立新的观察。")
                    return result(row, entry.data["reviewed"], already_confirmed=True)
                if row.data.get("pending_observation_id") != observation_id:
                    raise HTTPException(409, "已有更新的区域图片，请核对最新观察。")
                if row.data.get("paused") or row.data["state"] == "SESSION_SUMMARY" or lesson_id in voice_sessions:
                    raise HTTPException(409, "请先恢复文字课堂，再确认识别结果。")
                if entry.data["lesson_context"] != {
                    "state": row.data["state"],
                    "topic_index": row.data.get("topic_index"),
                }:
                    raise HTTPException(409, "课堂题目或阶段已变化，请重新选区识别。")
                if body.image_sha256 != original["source"]["sha256"]:
                    raise HTTPException(409, "图片版本不匹配，请重新打开观察记录。")
                if set(body.resolutions) != {a["id"] for a in original["ambiguities"]} or any(
                    not v.strip() for v in body.resolutions.values()
                ):
                    raise HTTPException(422, "请逐项填写所有歧义的确认结果。")
                eid = uid()
                reviewed = {
                    **original,
                    "steps": [s.model_dump() for s in body.steps],
                    "status": "confirmed",
                    "confirmed": True,
                    "confirmation_event_id": eid,
                    "step_complete": body.step_complete,
                    "resolutions": body.resolutions,
                    "uncertainty": "user_confirmed_transcription; mathematical_correctness_unassessed; localization_unverified",
                    "visible_text": "\n".join(s.text for s in body.steps if s.mark == "active"),
                }
                entry.data = {**entry.data, "status": "confirmed", "confirmation": submitted, "reviewed": reviewed}
                db.add(
                    Event(
                        id=eid,
                        lesson_id=lesson_id,
                        data={
                            "type": "observation_confirmation",
                            "observation_id": observation_id,
                            "image_sha256": body.image_sha256,
                            "confirmation": submitted,
                            "source": "student_review",
                        },
                    )
                )
                # Compact, confirmed-only handoff; original predictions/ambiguities remain in the audit record.
                teaching_observation = {
                    "id": observation_id,
                    "confirmation_event_id": eid,
                    "confirmed": True,
                    "step_complete": body.step_complete,
                    "uncertainty": reviewed["uncertainty"],
                    "steps": [s.model_dump() for s in body.steps if s.mark == "active"],
                    "visible_text": reviewed["visible_text"],
                    "image_sha256": body.image_sha256,
                }
                row.data = {**row.data, "observation": teaching_observation, "pending_observation_id": None}
                db.commit()  # Review survives a failed teaching call. Duplicate confirmation never bills twice.
                try:
                    response = await turn(db, row, db.get(Teacher, row.teacher_id), gateway, event="board")
                except ModelError as exc:
                    return result(row, reviewed, teaching_error=exc.message)
                response["observation"] = reviewed
                return response
