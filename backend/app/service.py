import copy
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .context import build_context
from .curriculum import BANK, grade
from .db import Event, Knowledge, Lesson
from .documents import retrieve
from .llm import ModelError
from .policy import BaselinePolicy, TeachingPolicy


def add_message(s, role, content):
    s.setdefault("messages", []).append({"role": role, "content": content})
    s["messages"] = s["messages"][-30:]


def answer_key(s):
    item = BANK[s.get("topic_index", 0)]
    return {
        "DIAGNOSTIC": item["answer"],
        "GUIDED_PRACTICE": item["practice_answer"],
        "INDEPENDENT_PRACTICE": item["independent_answer"],
    }.get(s["state"])


def record_evidence(db, lesson, s, text, result):
    item = BANK[s["topic_index"]]
    event = Event(
        lesson_id=lesson.id,
        data={
            "type": "assessment",
            "topic": item["topic"],
            "correct": result,
            "answer": text,
            "state": s["state"],
            "assisted": s.get("assisted", False),
            "method": "exact_polynomial_equivalence",
            "confidence": 1.0,
        },
    )
    db.add(event)
    db.flush()
    kid = lesson.teacher_id + ":" + item["topic"]
    row = db.get(Knowledge, kid)
    data = (
        copy.deepcopy(row.data)
        if row
        else {"topic": item["topic"], "attempts": 0, "correct": 0, "evidence": [], "history": []}
    )
    data["attempts"] += 1
    data["correct"] += int(result)
    data["observed_accuracy"] = data["correct"] / data["attempts"]
    data["confidence"] = min(0.9, data["attempts"] / (data["attempts"] + 5))
    data["confidence_note"] = "启发式证据充分度，非校准的掌握概率"
    data["evidence"] = (data["evidence"] + [event.id])[-30:]
    data["history"] = (
        data["history"] + [{"at": event.created_at, "correct": result, "assisted": s.get("assisted", False)}]
    )[-30:]
    data["next_review"] = (datetime.now(timezone.utc) + timedelta(days=7 if result else 1)).isoformat()
    if row:
        row.data = data
    else:
        db.add(Knowledge(id=kid, teacher_id=lesson.teacher_id, data=data))


async def turn(db, lesson, teacher, gateway, text="", event="message", *, voice_context=None):
    s = copy.deepcopy(lesson.data)
    if event == "auto" and (s["state"] not in ["PLANNING", "EXPLAINING"] or s.get("paused")):
        return {"lesson": public_lesson(lesson), "decision": None, "sources": []}
    if voice_context is not None:
        s["voice_context"] = voice_context
    if event == "message":
        command = text.strip().lower()
        if command in ["休息", "暂停", "pause", "先休息"]:
            event = "pause"
        elif command in ["结束", "结束课程", "end", "下课"]:
            event = "end"
        elif command in ["重讲", "再解释一次", "重新解释"]:
            event = "reexplain"
        elif command in ["提示", "给我提示", "hint"]:
            event = "hint"
    if text:
        add_message(s, "user", text)
    result = None
    expected = answer_key(s)
    if (voice_context is None or voice_context.get("input_source") == "typed") and event == "message" and expected and not s.get("paused") and s.get("mode") != "baseline":
        result = False if text.strip() in ["不会", "不知道", "不知道怎么做", "I don't know"] else grade(text, expected)
    policy = BaselinePolicy() if s.get("mode") == "baseline" else TeachingPolicy()
    if voice_context is not None and voice_context.get("input_source") != "typed" and event == "message" and s["state"] != "ONBOARDING":
        event = "voice"
    decision = policy.decide(s, text, event, result)
    # Profile persists across sessions, isolated by teacher.
    knowledge = [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher.id))]
    query = text + " " + BANK[s.get("topic_index", 0)]["title"] + " derivative differentiation"
    sources = retrieve(db, teacher.id, query)
    if gateway.settings.model_mode == "demo":
        if event == "topic" or s.get("mode") == "baseline":
            reply = "当前为离线演示，只支持内置求导课程。配置真实模型后才能讨论任意问题或运行 LLM 基线。"
        else:
            reply = decision.instruction
    elif event in ["pause", "resume", "end"] or decision.action == "WAIT":
        reply = decision.instruction
    else:
        try:
            messages = build_context(teacher.data, s, decision, sources, knowledge, gateway.settings)
        except ValueError:
            raise ModelError(
                "当前教师配置超出上下文预算。请增加 CONTEXT_TOKENS 或缩短配置。", "context_budget"
            ) from None
        role = decision.role
        if role == "fast":
            role = teacher.data.get("default_role", "fast")
        reply = await gateway.complete(db, lesson.id, role, messages)
    if result is not None:
        record_evidence(db, lesson, copy.deepcopy(lesson.data), text, result)
        db.flush()
        knowledge = [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher.id))]
    if decision.action == "WAIT" and event == "board":
        reply = ""
    if reply:
        add_message(s, "assistant", reply)
    if s["state"] == "SESSION_SUMMARY":
        s["summary"] = {
            "topic": BANK[s.get("topic_index", 0)]["title"],
            "profile": s.get("profile", {}),
            "diagnostic": s.get("diagnostic", []),
            "knowledge": knowledge,
            "next_step": "复习最近错误，再做一次独立迁移题。",
            "ended_at": datetime.now(timezone.utc).isoformat(),
        }
    if voice_context is not None:
        decision.auto = False  # Explicit continuation: generated speech is not proof it was heard.
    s["last_decision"] = decision.json()
    lesson.data = s
    db.add(
        Event(
            lesson_id=lesson.id,
            data={
                "type": "turn",
                "event": event,
                "decision": decision.json(),
                "state": s["state"],
                "input": text if gateway.settings.retain_transcripts else None,
                "output": reply if gateway.settings.retain_transcripts else None,
                "sources": [{"document_id": c["document_id"], "page": c["page"]} for c in sources],
            },
        )
    )
    db.commit()
    return {"lesson": public_lesson(lesson), "decision": decision.json(), "sources": sources}


def public_lesson(lesson):
    item = BANK[lesson.data.get("topic_index", 0)]
    exercise = {
        "DIAGNOSTIC": item["question"],
        "GUIDED_PRACTICE": item["practice"],
        "INDEPENDENT_PRACTICE": item["independent"],
    }.get(lesson.data["state"])
    return {
        "id": lesson.id,
        "teacher_id": lesson.teacher_id,
        "created_at": lesson.created_at,
        **lesson.data,
        "current_exercise": exercise,
    }


def new_lesson(db, teacher_id, mode):
    previous = db.scalars(
        select(Lesson).where(Lesson.teacher_id == teacher_id).order_by(Lesson.created_at.desc())
    ).first()
    if previous and previous.data["state"] != "SESSION_SUMMARY" and previous.data.get("mode") == mode:
        return previous
    profile = previous.data.get("profile", {}) if previous else {}
    state = {
        "state": "ONBOARDING",
        "profile": profile,
        "mode": mode,
        "topic_index": 0,
        "paused": False,
        "messages": [],
        "board": None,
        "last_summary": previous.data.get("summary", {}) if previous else {},
    }
    if previous and mode != "baseline" and profile.get("exam_board"):
        knowledge = list(db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher_id)))
        due = [k for k in knowledge if k.data.get("next_review", "") <= datetime.now(timezone.utc).isoformat()]
        weakest = min(due or knowledge, key=lambda k: k.data["observed_accuracy"], default=None)
        state["topic_index"] = next(
            (i for i, item in enumerate(BANK) if weakest and item["topic"] == weakest.data["topic"]), 0
        )
        state["state"] = "EXPLAINING"
        state["last_decision"] = {"auto": True}
        add_message(
            state,
            "assistant",
            "上次的学习记录还在。今天先复习" + BANK[state["topic_index"]]["title"] + "，看看能不能独立用出来。",
        )
    else:
        add_message(
            state,
            "assistant",
            "我是你的数学老师。你最近在学什么，希望什么时候达到什么目标？可以直接说，也可以先上传教材。",
        )
    row = Lesson(teacher_id=teacher_id, data=state)
    db.add(row)
    db.commit()
    return row
