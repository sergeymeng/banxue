"""Teaching-side contracts only. Adapters execute actions and supply receipts.

No receipt is a comprehension claim. No generated board action is a visible fact.
"""

import copy
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .teaching_observations import confirmed_observation
from .teaching_steps import STEPS, current_step


class TeachingEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=1, max_length=100)
    kind: Literal["board_receipt", "vision_observation"]
    action_id: str | None = Field(default=None, max_length=100)
    exercise_key: str | None = Field(default=None, max_length=100)
    status: Literal["executed", "failed", "cancelled"] | None = None
    visible_text: str = Field(default="", max_length=800)
    confidence: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    step_complete: bool = False
    observation: dict | None = None
    executed_revision: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def required_fields(self):
        if self.kind == "board_receipt" and (not self.action_id or self.status is None):
            raise ValueError("board receipt requires action_id and status")
        if self.kind == "vision_observation" and not self.exercise_key:
            raise ValueError("vision observation requires exercise_key")
        return self


def apply_events(s, events):
    """Apply a whole batch atomically, including semantic confirmation checks."""
    updated = copy.deepcopy(s)
    _apply_events(updated, events)
    s.clear()
    s.update(updated)


def _apply_events(s, events):
    """Validate an entire batch before applying it; callers commit with their turn."""
    if len(events) > 100:
        raise ValueError("at most 100 teaching events per batch")
    parsed = [TeachingEvent.model_validate(e) for e in events]
    seen = s.setdefault("teaching_event_ids", [])
    for event in parsed:
        if event.event_id in seen:
            continue
        if event.kind == "board_receipt":
            action = next((a for a in s.get("board_actions", []) if a["action_id"] == event.action_id), None)
            if (
                action is None
                or action["status"] != "proposed"
                or s.get("paused")
                or s["state"] == "SESSION_SUMMARY"
                or action.get("exercise_key") != f"{s.get('topic_index', 0)}:{s['state']}"
            ):
                continue
            action.update(status=event.status, receipt_id=event.event_id)
            if event.status == "executed" and event.executed_revision is not None:
                action["executed_revision"] = event.executed_revision
        else:
            if event.exercise_key != f"{s.get('topic_index', 0)}:{s['state']}" or s.get("paused"):
                continue
            observation = event.observation or {
                "visible_text": event.visible_text,
                "confidence": event.confidence,
                "step_complete": event.step_complete,
                "evidence_id": event.event_id,
            }
            if observation.get("confirmed"):
                if s.get("pending_observation_id") not in {None, observation.get("id")}:
                    continue
                candidate = {**s, "observation": observation, "pending_observation_id": None}
                reviewed = confirmed_observation(candidate)
                if reviewed is None or reviewed["exercise_key"] != event.exercise_key:
                    raise ValueError("confirmed observation requires bound provenance and student review")
                s["observation"] = reviewed
                s["pending_observation_id"] = None
            else:
                s["observation"] = dict(observation)
        seen.append(event.event_id)
    s["teaching_event_ids"] = seen[-100:]


def propose_question(s, decision, text, *, evidence_state=None):
    """Bounded teaching intents, translated to board v1 by the integration host."""
    current_key = f"{s.get('topic_index', 0)}:{s['state']}"
    actions = s.get("board_actions", [])
    for action in actions:
        if action["status"] == "proposed" and action["exercise_key"] != current_key:
            action["status"] = "cancelled"
    specs = []
    if decision.reason in {
        "start_diagnostic",
        "next_diagnostic",
        "begin_guided",
        "guided_passed",
        "student_next",
        "return_to_exercise",
    }:
        s.pop("observation", None)
        for action in actions:
            if action["status"] == "proposed":
                action["status"] = "cancelled"
        specs.append(("question", text, []))
        if decision.reason in {"begin_guided", "student_next"}:
            specs.append(("step_prompt", current_step(s)[0], []))
    elif decision.reason in {"student_hint", "student_reexplain", "step_retry", "incorrect_answer"}:
        if s.get("assisted") and s["state"] in {"DIAGNOSTIC", "GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"}:
            prompt, _, explanation = current_step(s)
            content = explanation + " " + prompt if decision.reason == "student_reexplain" else prompt
            specs.append(("step_prompt", content, []))
    elif decision.reason == "step_passed" and evidence_state:
        check = s.get("last_check") or {}
        steps = STEPS.get((s.get("topic_index", 0), s["state"]), [])
        index = check.get("step", -1)
        if (
            check.get("scope") == "step"
            and check.get("correct") is True
            and check.get("evidence_id")
            and check.get("exercise_key") == current_key
            and 0 <= index < len(steps)
        ):
            expression = steps[index][1].replace("*", "·")
            for power, glyph in [("^2", "²"), ("^3", "³"), ("^4", "⁴"), ("^5", "⁵")]:
                expression = expression.replace(power, glyph)
            label = ["du/dx", "dy/du"][index] if s.get("topic_index", 0) == 0 else f"步骤 {index + 1}"
            specs.append(("verified_step", label + " = " + expression, [check["evidence_id"]]))
            specs.append(("step_prompt", current_step(s)[0], []))
    if not specs:
        return
    for action in actions:
        if action["status"] == "proposed" and action.get("purpose") == "step_prompt":
            action["status"] = "cancelled"
    for purpose, content, evidence_ids in specs:
        action = {
            "action_id": uuid4().hex,
            "kind": "write_math",
            "text": content[:400],
            "exercise_key": current_key,
            "status": "proposed",
            "purpose": purpose,
            "step_index": (
                s["last_check"]["step"] if purpose == "verified_step" else (s.get("exercise_flow") or {}).get("step", 0)
            ),
            "evidence_ids": evidence_ids,
        }
        actions.append(action)
        decision.board_actions.append(dict(action))
    for action in actions[:-20]:
        if action["status"] == "proposed":
            decision.board_cancellations.append(action["action_id"])
    s["board_actions"] = actions[-20:]


def delivery_context(s):
    voice = s.get("voice_context") or {}
    completed = [r for r in voice.get("heard_completed", []) if r.get("status") == "completed"][-2:]
    return {
        "heard_completed": completed,
        "interrupted_segment_not_fully_heard": voice.get("interrupted_at"),
        "hearing_is_not_understanding": True,
        "board_executed": [a for a in s.get("board_actions", []) if a["status"] == "executed"][-3:],
        "board_pending_not_visible": [a for a in s.get("board_actions", []) if a["status"] == "proposed"][-3:],
    }
