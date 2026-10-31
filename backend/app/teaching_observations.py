"""Confirmed-only teaching boundary, independent of the handwriting implementation.

The adapter owns image review. Confirmation proves transcription provenance, never
mathematical correctness. Legacy confidence is deliberately not an authorization.
"""

import copy

from .db import Event
from .teaching_steps import exercise_key


def confirmed_observation(s):
    obs = s.get("observation") or {}
    if s.get("pending_observation_id") or obs.get("confirmed") is not True:
        return None
    if s.get("latest_observation_id") and s["latest_observation_id"] != obs.get("id"):
        return None
    if obs.get("exercise_key") != exercise_key(s):
        return None
    if not all(obs.get(k) for k in ("id", "confirmation_event_id", "source", "uncertainty")):
        return None
    source = obs["source"]
    if not isinstance(source, dict) or not source.get("kind") or not source.get("sha256"):
        return None
    if source["sha256"] != obs.get("image_sha256"):
        return None
    steps = obs.get("steps")
    if not isinstance(steps, list) or not steps or len(steps) > 40:
        return None
    if any(not isinstance(step, dict) or step.get("mark") not in {"active", "crossed_out"} for step in steps):
        return None
    active = [step for step in steps if step["mark"] == "active"]
    if not active or any(not step.get("id") or not isinstance(step.get("text"), str) for step in active):
        return None
    # Never trust visible_text: it can contain crossed-out predictions or stale text.
    return {
        "id": obs["id"],
        "confirmation_event_id": obs["confirmation_event_id"],
        "exercise_key": obs["exercise_key"],
        "confirmed": True,
        "step_complete": obs.get("step_complete") is True,
        "source": copy.deepcopy(source),
        "image_sha256": obs["image_sha256"],
        "steps": [{"id": step["id"], "text": step["text"][:800], "mark": "active"} for step in active],
        "visible_text": "\n".join(step["text"][:800] for step in active)[:1600],
        "uncertainty": "student_reviewed_transcription; mathematical_correctness_unassessed; localization_unverified",
    }


def bind_handwriting_observation(db, lesson, s):
    """Enrich the handwriting branch's compact handoff from its durable Events.

    No import of observations/vision, no route changes, and no inferred provenance.
    """
    obs = s.get("observation") or {}
    if not obs.get("confirmed") or obs.get("exercise_key"):
        return
    original = db.get(Event, obs.get("id")) if obs.get("id") else None
    confirmation = db.get(Event, obs.get("confirmation_event_id")) if obs.get("confirmation_event_id") else None
    if not original or not confirmation or original.lesson_id != lesson.id or confirmation.lesson_id != lesson.id:
        return
    entry, receipt = original.data, confirmation.data
    source = (entry.get("observation") or {}).get("source") or {}
    context = {"state": s["state"], "topic_index": s.get("topic_index")}
    if "last_turn_id" in entry.get("lesson_context", {}):
        # Imported at call time: observation_binding also uses service.public_lesson.
        from .observation_binding import lesson_context
        context = lesson_context(lesson, db)
    if (
        entry.get("type") != "region_observation"
        or entry.get("status") != "confirmed"
        or entry.get("lesson_context") != context
        or receipt.get("type") != "observation_confirmation"
        or receipt.get("source") != "student_review"
        or receipt.get("observation_id") != original.id
        or not source.get("sha256")
        or receipt.get("image_sha256") != source["sha256"]
        or obs.get("image_sha256") != source["sha256"]
    ):
        return
    reviewed = entry.get("reviewed") or {}
    if reviewed.get("confirmation_event_id") != confirmation.id or reviewed.get("confirmed") is not True:
        return
    # Use the stored reviewed steps, not an independently supplied compact text.
    s["observation"] = {
        **copy.deepcopy(reviewed),
        "steps": [copy.deepcopy(step) for step in reviewed.get("steps", []) if step.get("mark") == "active"],
        "id": original.id,
        "source": copy.deepcopy(source),
        "image_sha256": source["sha256"],
        "exercise_key": exercise_key(s),
    }
