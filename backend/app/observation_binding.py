"""Bind a transcription to the saved student board and the current exercise context."""

import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import select

from .db import Event
from .service import public_lesson


def lesson_context(row, db):
    s = row.data
    flow = s.get("exercise_flow") or {}
    latest_turn = db.scalar(
        select(Event.id)
        .where(Event.lesson_id == row.id, Event.data["type"].as_string() == "turn")
        .order_by(Event.created_at.desc(), Event.id.desc())
        .limit(1)
    )
    return {
        "last_turn_id": latest_turn,
        "state": s["state"],
        "topic_index": s.get("topic_index"),
        "exercise": public_lesson(row).get("current_exercise"),
        "exercise_key": flow.get("key"),
        "step": flow.get("step"),
        "detour": s.get("detour"),
        "teaching_revision": s.get("teaching_revision"),
    }


def board_binding(row, source):
    if source["kind"] != "whiteboard_region":
        return None
    board = row.data.get("board") or {}
    if (
        board.get("format") != "banxue-board"
        or board.get("version") != 1
        or board.get("revision") != source.get("revision")
    ):
        raise HTTPException(409, "白板已变化或尚未保存，请重新读取这一步。")
    rect = source["region"]
    if (
        rect["x"] < 0
        or rect["y"] < 0
        or rect["x"] + rect["width"] > board.get("width", 0)
        or rect["y"] + rect["height"] > board.get("height", 0)
    ):
        raise HTTPException(409, "选区超出当前白板。")
    # Same intersection rule as exportRegion. An omitted stroke or teacher element cannot be relabelled student.
    elements = board.get("elements") or []
    try:
        selected = [
            e
            for e in elements
            if e["author"] == "student"
            and e["x"] < rect["x"] + rect["width"]
            and e["x"] + e["width"] > rect["x"]
            and e["y"] < rect["y"] + rect["height"]
            and e["y"] + e["height"] > rect["y"]
        ]
        if {e["id"] for e in selected} != set(source.get("element_ids", [])) or not selected:
            raise ValueError()
        canonical = json.dumps([e for e in elements if e["author"] == "student"], sort_keys=True, ensure_ascii=False)
    except (KeyError, TypeError, ValueError):
        raise HTTPException(409, "区域笔迹与已保存白板不一致，请重新选区。") from None
    return {"revision": board["revision"], "student_sha256": hashlib.sha256(canonical.encode()).hexdigest()}


def assert_current(row, entry, db):
    if entry["lesson_context"] != lesson_context(row, db):
        raise HTTPException(409, "课堂题目或步骤已变化，请重新读取这一步。")
    binding = board_binding(row, entry["observation"]["source"])
    if binding != entry.get("board_binding"):
        raise HTTPException(409, "学生笔迹已变化，请重新读取这一步。")
