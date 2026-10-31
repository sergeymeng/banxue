import copy
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .context import build_context
from .curriculum import BANK
from .db import Event, Knowledge, Lesson
from .documents import retrieve
from .llm import ModelError
from .policy import BaselinePolicy, TeachingPolicy
from .teaching_contracts import apply_events, propose_question
from .teaching_language import demo_reply
from .teaching_steps import conversational_event, interpret_answer, next_prompt, question


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


def record_evidence(db, lesson, s, text, result, check=None):
    item = BANK[s["topic_index"]]
    event = Event(
        lesson_id=lesson.id,
        data={
            "type": "step_assessment" if check and check["scope"] == "step" else "assessment",
            "exercise_key": f"{s.get('topic_index', 0)}:{s['state']}",
            "step": check.get("step") if check else None,
            "topic": item["topic"],
            "correct": result,
            "answer": text,
            "state": s["state"],
            "assisted": s.get("assisted", False),
            "method": "exact_polynomial_equivalence",
            "confidence": 1.0,
            "uncertainty": "只验证此表达式的多项式等价性，不推断理解或长期掌握。",
        },
    )
    db.add(event)
    db.flush()
    if check and check["scope"] == "step":
        return event.id
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
    data["uncertainty"] = "有限题目证据；受提示、猜测和短期记忆影响，不能认定长期掌握。"
    data["confidence_note"] = "启发式证据充分度，非校准的掌握概率"
    data["evidence"] = (data["evidence"] + [event.id])[-30:]
    data["history"] = (
        data["history"] + [{"at": event.created_at, "evidence_id": event.id, "correct": result,
                            "assisted": s.get("assisted", False)}]
    )[-30:]
    data["next_review"] = (datetime.now(timezone.utc) + timedelta(days=7 if result and not s.get("assisted") else 1)).isoformat()
    if row:
        row.data = data
    else:
        db.add(Knowledge(id=kid, teacher_id=lesson.teacher_id, data=data))

    return event.id


def receive_teaching_events(db, lesson, events):
    """Adapter boundary: ingestion never calls a model or advances teaching."""
    s = copy.deepcopy(lesson.data)
    apply_events(s, events)
    lesson.data = s
    db.commit()
    return public_lesson(lesson)


async def turn(db, lesson, teacher, gateway, text="", event="message", *, voice_context=None):
    s = copy.deepcopy(lesson.data)
    if event == "auto" and (s["state"] not in ["PLANNING", "EXPLAINING"] or s.get("paused") or voice_context is not None):
        return {"lesson": public_lesson(lesson), "decision": None, "sources": []}
    if voice_context is not None:
        s["voice_context"] = voice_context
    s.pop("answer_check", None)
    if event == "message":
        event = conversational_event(text)
        if event == "message" and s.get("pending_correction"):
            event = "correction_detail"
    if text:
        add_message(s, "user", text)
    result = None
    check = None
    expected = answer_key(s)
    typed = voice_context is None or voice_context.get("input_source") == "typed"
    if typed and event == "message" and expected and not s.get("paused") and s.get("mode") != "baseline":
        check = interpret_answer(s, text, expected)
        s["answer_check"] = check
        if check and check["scope"] == "final":
            result = check["correct"]
    evidence_state = copy.deepcopy(s)
    policy = BaselinePolicy() if s.get("mode") == "baseline" else TeachingPolicy()
    if not typed and event == "message" and s["state"] != "ONBOARDING":
        event = "voice"
    decision = policy.decide(s, text, event, result)
    if s.get("mode") != "baseline":
        propose_question(s, decision, question(s))
    # Profile persists across sessions, isolated by teacher.
    knowledge = [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher.id))]
    query = text + " " + BANK[s.get("topic_index", 0)]["title"] + " derivative differentiation"
    sources = retrieve(db, teacher.id, query)
    if gateway.settings.model_mode == "demo":
        reply = demo_reply(s, decision, text)
    elif event in ["pause", "resume", "end"] or decision.action == "WAIT" or decision.reason == "uncertain_observation":
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
    if check is not None:
        evidence_id = record_evidence(db, lesson, evidence_state, text, check["correct"], check)
        s["last_check"] = {**check, "evidence_id": evidence_id,
                           "exercise_key": f"{evidence_state.get('topic_index', 0)}:{evidence_state['state']}",
                           "uncertainty": "表达式校验不代表理解或长期掌握。"}
        if evidence_state["state"] == "DIAGNOSTIC" and check["scope"] == "final":
            s["diagnostic"][-1].update(evidence_id=evidence_id, uncertainty=s["last_check"]["uncertainty"])
        s.pop("answer_check", None)
        db.flush()
        knowledge = [r.data for r in db.scalars(select(Knowledge).where(Knowledge.teacher_id == teacher.id))]
    if decision.action == "WAIT" and event == "board":
        reply = ""
    if reply:
        add_message(s, "assistant", reply)
    if s["state"] == "SESSION_SUMMARY" and not s.get("summary"):
        s["summary"] = {
            "topic": BANK[s.get("topic_index", 0)]["title"],
            "profile": s.get("profile", {}),
            "diagnostic": s.get("diagnostic", []),
            "knowledge": knowledge,
            "next_step": "接着未完成的步骤练习，再用独立题检查。",
            "continuation": s.get("continuation"),
            "last_check": s.get("last_check"),
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
    continuation = previous.data.get("summary", {}).get("continuation") if previous else None
    if (continuation and mode != "baseline" and previous.data.get("mode") == mode
            and continuation["state"] in {"DIAGNOSTIC", "GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"}):
        state.update(copy.deepcopy(continuation))
        state["diagnostic"] = copy.deepcopy(previous.data.get("diagnostic", []))
        state["last_decision"] = {"auto": False}
        state["board"] = copy.deepcopy(previous.data.get("board"))
        prompt = "接着上次未完成的题：" + question(state)
        if (state.get("exercise_flow") or {}).get("scaffold"):
            prompt += " " + next_prompt(state)
        add_message(state, "assistant", prompt)
    elif previous and mode != "baseline" and profile.get("exam_board"):
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
