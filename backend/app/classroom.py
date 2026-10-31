"""Local classroom surfaces. These records never establish teaching evidence."""
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .db import Document, Lesson, MaterialInk


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class Stroke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    color: Literal["#202632", "#2563eb", "#d44242"]
    width: float = Field(ge=0.001, le=0.02, allow_inf_nan=False)
    points: list[Point] = Field(min_length=2, max_length=4096)


class InkInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    strokes: list[Stroke] = Field(max_length=1500)

    @model_validator(mode="after")
    def bounded(self):
        if len({s.id for s in self.strokes}) != len(self.strokes):
            raise ValueError("笔迹 ID 重复")
        if sum(len(s.points) for s in self.strokes) > 60000:
            raise ValueError("本页笔迹过多")
        return self


class ClassroomView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str | None = Field(default=None, max_length=100)
    page: int = Field(default=1, ge=1, le=300)


def install_classroom(app, settings, factory, lock):
    def record(db, cls, key):
        row = db.get(cls, key)
        if row is None:
            raise HTTPException(404, "记录不存在。")
        return row

    def check_page(db, lesson_id, document_id, page):
        lesson = record(db, Lesson, lesson_id)
        document = record(db, Document, document_id)
        if document.teacher_id != lesson.teacher_id or not 1 <= page <= document.data["pages"]:
            raise HTTPException(404, "教材页不存在。")
        return lesson

    @app.get("/api/teachers/{teacher_id}/documents/{document_id}/file")
    def document_file(teacher_id: str, document_id: str):
        with factory() as db:
            document = record(db, Document, document_id)
            if document.teacher_id != teacher_id:
                raise HTTPException(404, "教材不存在。")
            path = settings.data_dir / f"{document.id}.pdf"
            if not path.is_file():
                raise HTTPException(404, "教材文件不存在。")
            return FileResponse(path, media_type="application/pdf", filename=document.data["name"],
                                content_disposition_type="inline", headers={"Cache-Control": "no-store"})

    @app.put("/api/lessons/{lesson_id}/classroom")
    async def classroom_view(lesson_id: str, body: ClassroomView):
        async with lock:
            with factory() as db:
                lesson = (check_page(db, lesson_id, body.document_id, body.page) if body.document_id
                          else record(db, Lesson, lesson_id))
                lesson.data = {**lesson.data, "classroom": body.model_dump()}
                db.commit()
                return body.model_dump()

    @app.get("/api/lessons/{lesson_id}/documents/{document_id}/pages/{page}/ink")
    def get_ink(lesson_id: str, document_id: str, page: int):
        with factory() as db:
            check_page(db, lesson_id, document_id, page)
            row = db.get(MaterialInk, f"{lesson_id}:{document_id}:{page}")
            return row.data if row else {"revision": 0, "strokes": []}

    @app.put("/api/lessons/{lesson_id}/documents/{document_id}/pages/{page}/ink")
    async def save_ink(lesson_id: str, document_id: str, page: int, body: InkInput):
        async with lock:
            with factory() as db:
                check_page(db, lesson_id, document_id, page)
                key = f"{lesson_id}:{document_id}:{page}"
                row = db.get(MaterialInk, key)
                previous = row.data if row else {"revision": 0, "strokes": []}
                strokes = [s.model_dump() for s in body.strokes]
                # A retry after a lost acknowledgement is idempotent.
                if body.revision != previous["revision"]:
                    if body.revision + 1 == previous["revision"] and strokes == previous["strokes"]:
                        return previous
                    raise HTTPException(409, "本页已在其他窗口更新，请保留当前笔迹后重新打开。")
                data = {"revision": body.revision + 1, "strokes": strokes}
                if row:
                    row.data = data
                else:
                    db.add(MaterialInk(id=key, lesson_id=lesson_id, document_id=document_id, page=page, data=data))
                db.commit()
                return data
