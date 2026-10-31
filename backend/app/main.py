import asyncio
import base64
import json
import secrets
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy import text as sql

from .config import Settings
from .db import Document, Event, Knowledge, Lesson, Teacher, Usage, database, uid
from .documents import index_chunks, parse_pdf, retrieve
from .llm import Gateway, ModelError
from .observations import install_observations
from .service import new_lesson, public_lesson, receive_teaching_events, turn
from .vision import GatewayVisionService
from .voice_session import install_voice


class TeacherInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    subject: str = Field(default="A-level 数学", max_length=100)
    language: str = Field(default="中文", max_length=40)
    style: str = Field(default="耐心、善于启发", max_length=300)
    preferences: str = Field(default="先提示，再解释", max_length=500)
    default_role: Literal["fast", "reasoning"] = "fast"


class StartInput(BaseModel):
    mode: Literal["policy", "baseline"] = "policy"


class TurnInput(BaseModel):
    text: str = Field(default="", max_length=4000)
    event: Literal["message", "auto", "pause", "resume", "end", "reexplain", "hint", "topic"] = "message"


class BoardInput(BaseModel):
    snapshot: dict


class BoardReceiptInput(BaseModel):
    event_id: str = Field(min_length=1, max_length=100)
    action_id: str = Field(min_length=1, max_length=100)
    status: Literal["executed", "failed", "cancelled"]
    revision: int = Field(ge=0)


class BoardReceiptsInput(BaseModel):
    receipts: list[BoardReceiptInput] = Field(min_length=1, max_length=100)


def create_app(settings=None, transport=None, vision_service=None):
    settings = settings or Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    factory, engine = database(settings.data_dir / "tutor.db")
    app = FastAPI(title="本地私人教师", version="0.1.0")
    app.state.factory, app.state.engine = factory, engine
    app.state.settings = settings
    gateway = Gateway(settings, transport)
    lock = asyncio.Lock()  # This MVP MUST run one worker: protects budget reservations and lesson transitions.
    in_flight = {}
    voice_sessions = install_voice(app, settings, factory, lock, transport)
    install_observations(app, settings, factory, lock, gateway,
                         vision_service or GatewayVisionService(gateway), voice_sessions)
    origins = settings.allowed_origins.split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver", "backend"])

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if settings.desktop_token and not secrets.compare_digest(
            request.headers.get("x-desktop-token", ""), settings.desktop_token
        ):
            return JSONResponse({"detail": "需要桌面应用授权。"}, status_code=401)
        origin = request.headers.get("origin")
        if origin and origin not in origins:
            return JSONResponse({"detail": "不允许该 Origin 访问本机学习数据。"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(ModelError)
    async def model_error(_, exc):
        return JSONResponse(
            {"detail": exc.message, "code": exc.code},
            status_code=402 if exc.code == "budget_exceeded" else (409 if exc.code == "interrupted" else 502),
        )

    def get(db, cls, id):
        row = db.get(cls, id)
        if not row:
            raise HTTPException(404, "记录不存在。")
        return row

    @app.get("/health")
    def health():
        return {"status": "ok", "mode": settings.model_mode}

    @app.get("/api/config")
    def config():
        return {
            "mode": settings.model_mode,
            "roles": {
                role: {k: v for k, v in settings.role(role).items() if k != "api_key"}
                for role in ["fast", "reasoning", "vision"]
            },
            "budgets": {
                "request": settings.request_budget_gbp,
                "session": settings.session_budget_gbp,
                "day": settings.daily_budget_gbp,
            },
            "context_tokens": settings.context_tokens,
            "retention": settings.retain_transcripts,
        }

    @app.get("/api/teachers")
    def teachers():
        with factory() as db:
            return [{"id": t.id, **t.data} for t in db.scalars(select(Teacher))]

    @app.post("/api/teachers")
    async def create_teacher(body: TeacherInput):
        async with lock:
            with factory() as db:
                row = Teacher(data=body.model_dump())
                db.add(row)
                db.commit()
                return {"id": row.id, **row.data}

    @app.post("/api/teachers/{teacher_id}/lessons")
    async def start(teacher_id: str, body: StartInput):
        async with lock:
            with factory() as db:
                get(db, Teacher, teacher_id)
                return public_lesson(new_lesson(db, teacher_id, body.mode))

    @app.get("/api/teachers/{teacher_id}/lessons")
    def lessons(teacher_id: str):
        with factory() as db:
            get(db, Teacher, teacher_id)
            return [
                public_lesson(r)
                for r in db.scalars(
                    select(Lesson).where(Lesson.teacher_id == teacher_id).order_by(Lesson.created_at.desc())
                )
            ]

    @app.get("/api/lessons/{lesson_id}")
    def lesson(lesson_id: str):
        with factory() as db:
            return public_lesson(get(db, Lesson, lesson_id))

    @app.post("/api/lessons/{lesson_id}/turn")
    async def message(lesson_id: str, body: TurnInput):
        if lesson_id in voice_sessions:
            if body.event in {"pause", "end"}:
                await voice_sessions[lesson_id].close()
            else:
                raise HTTPException(409, "语音课堂正在使用该课堂，请通过语音连接发送文字或先结束语音。")
        should_interrupt = body.event in ["pause", "end"] or body.text.strip().lower() in [
            "休息",
            "暂停",
            "pause",
            "先休息",
            "结束",
            "结束课程",
            "end",
            "下课",
        ]
        if should_interrupt and lesson_id in in_flight:
            in_flight[lesson_id].cancel()
        async with lock:
            in_flight[lesson_id] = asyncio.current_task()
            try:
                with factory() as db:
                    row = get(db, Lesson, lesson_id)
                    return await turn(db, row, get(db, Teacher, row.teacher_id), gateway, body.text, body.event)
            finally:
                in_flight.pop(lesson_id, None)

    @app.post("/api/lessons/{lesson_id}/stream")
    async def stream(lesson_id: str, body: TurnInput):
        async def events():
            yield 'event: status\ndata: {"status":"thinking"}\n\n'
            try:
                result = await message(lesson_id, body)
                yield "event: result\ndata: " + json.dumps(result, ensure_ascii=False) + "\n\n"
            except (ModelError, HTTPException) as exc:
                detail = exc.message if isinstance(exc, ModelError) else exc.detail
                yield "event: error\ndata: " + json.dumps({"detail": detail}, ensure_ascii=False) + "\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.put("/api/lessons/{lesson_id}/board")
    async def board(lesson_id: str, body: BoardInput):
        if len(json.dumps(body.snapshot)) > 5_000_000:
            raise HTTPException(413, "白板超过 5MB，请减少图片或页面。")
        async with lock:
            with factory() as db:
                row = get(db, Lesson, lesson_id)
                row.data = {**row.data, "board": body.snapshot}
                db.commit()
                return {"saved": True}

    @app.post("/api/lessons/{lesson_id}/board/receipts")
    async def board_receipts(lesson_id: str, body: BoardReceiptsInput):
        # The UI flushes its snapshot first. Delivery receipts are never grading evidence.
        async with lock:
            with factory() as db:
                row = get(db, Lesson, lesson_id)
                snapshot = row.data.get("board") or {}
                if snapshot.get("format") != "banxue-board":
                    raise HTTPException(409, "请先保存当前白板，再同步板书状态。")
                queue = snapshot.get("queue")
                if not isinstance(queue, dict) or not isinstance(queue.get("steps"), list):
                    raise HTTPException(409, "白板队列格式不完整。")
                steps = {step["action"].get("id"): step for step in queue["steps"]
                         if isinstance(step, dict) and isinstance(step.get("action"), dict)}
                events = []
                for receipt in body.receipts:
                    step = steps.get(receipt.action_id)
                    if (step is None or step.get("status") != receipt.status
                            or receipt.revision > snapshot.get("revision", -1)
                            or (receipt.status == "executed"
                                and step.get("executedRevision") != receipt.revision)):
                        raise HTTPException(409, "板书回执与已保存的白板不一致。")
                    events.append({"event_id": receipt.event_id, "kind": "board_receipt",
                                   "action_id": receipt.action_id, "status": receipt.status})
                receive_teaching_events(db, row, events)
                return {"saved": True}

    @app.post("/api/teachers/{teacher_id}/documents")
    async def upload(teacher_id: str, file: UploadFile = File(...), scope: str = Form("用户上传，考纲范围未核验")):
        content = await file.read(20 * 1024 * 1024 + 1)
        try:
            parsed = await asyncio.to_thread(parse_pdf, content)
        except Exception:
            raise HTTPException(
                422, "PDF 解析失败：仅支持 20MB / 300 页以内、未加密且结构有效的 PDF。扫描版需要 OCR。"
            ) from None
        async with lock:
            with factory() as db:
                get(db, Teacher, teacher_id)
                did = uid()
                name = Path(file.filename or "material.pdf").name[:160]
                metadata = {k: v for k, v in parsed.items() if k != "chunks"}
                metadata.update(name=name, scope=scope[:300], chunk_count=len(parsed["chunks"]))
                path = settings.data_dir / f"{did}.pdf"
                path.write_bytes(content)
                path.chmod(0o600)
                try:
                    db.add(Document(id=did, teacher_id=teacher_id, data=metadata))
                    index_chunks(db, did, teacher_id, parsed["chunks"])
                    db.commit()
                except Exception:
                    path.unlink(missing_ok=True)
                    raise
                return {"id": did, **metadata}

    @app.get("/api/teachers/{teacher_id}/documents")
    def documents(teacher_id: str):
        with factory() as db:
            return [
                {"id": d.id, **d.data} for d in db.scalars(select(Document).where(Document.teacher_id == teacher_id))
            ]

    @app.get("/api/teachers/{teacher_id}/search")
    def search(teacher_id: str, q: str = ""):
        with factory() as db:
            return retrieve(db, teacher_id, q[:500])

    @app.get("/api/teachers/{teacher_id}/memory")
    def memory(teacher_id: str):
        with factory() as db:
            return [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher_id))]

    @app.get("/api/lessons/{lesson_id}/usage")
    def usage(lesson_id: str):
        with factory() as db:
            get(db, Lesson, lesson_id)
            rows = list(db.scalars(select(Usage).where(Usage.lesson_id == lesson_id)))
            return {
                "estimated_cost_gbp": sum(r.charged_gbp for r in rows),
                "billing_note": "按配置价格估算，非真实账单；不确定请求保留预算。",
                "input_tokens": sum(r.data.get("input_tokens") or 0 for r in rows),
                "output_tokens": sum(r.data.get("output_tokens") or 0 for r in rows),
                "requests": [{"id": r.id, "created_at": r.created_at, **r.data} for r in rows],
            }

    @app.get("/api/teachers/{teacher_id}/export")
    def export(teacher_id: str):
        with factory() as db:
            teacher = get(db, Teacher, teacher_id)
            lessons = list(db.scalars(select(Lesson).where(Lesson.teacher_id == teacher_id)))
            ids = [r.id for r in lessons]
            docs = list(db.scalars(select(Document).where(Document.teacher_id == teacher_id)))
            return {
                "schema_version": 1,
                "teacher": {"id": teacher.id, **teacher.data},
                "lessons": [public_lesson(r) for r in lessons],
                "knowledge": [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher_id))],
                "documents": [
                    {
                        "id": d.id,
                        **d.data,
                        "pdf_base64": base64.b64encode((settings.data_dir / f"{d.id}.pdf").read_bytes()).decode(),
                    }
                    for d in docs
                ],
                "events": [
                    {"id": e.id, "lesson_id": e.lesson_id, "created_at": e.created_at, **e.data}
                    for e in db.scalars(select(Event).where(Event.lesson_id.in_(ids)))
                ],
                "usage": [
                    {"id": u.id, "lesson_id": u.lesson_id, "created_at": u.created_at, **u.data}
                    for u in db.scalars(select(Usage).where(Usage.lesson_id.in_(ids)))
                ],
            }

    @app.delete("/api/teachers/{teacher_id}")
    async def delete(teacher_id: str):
        with factory() as db:
            ids = list(db.scalars(select(Lesson.id).where(Lesson.teacher_id == teacher_id)))
        for lid in ids:
            if lid in voice_sessions:
                await voice_sessions[lid].close()
        async with lock:
            with factory() as db:
                row = get(db, Teacher, teacher_id)
                docs = list(db.scalars(select(Document).where(Document.teacher_id == teacher_id)))
                db.execute(sql("DELETE FROM chunks WHERE teacher_id=:t"), {"t": teacher_id})
                db.delete(row)
                db.commit()
                for d in docs:
                    (settings.data_dir / f"{d.id}.pdf").unlink(missing_ok=True)
                return {"deleted": True}

    if settings.frontend_dir:
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="desktop-ui")
    return app


app = create_app()
