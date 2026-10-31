"""Teaching-side contracts only. Adapters execute actions and supply receipts.

No receipt is a comprehension claim. No generated board action is a visible fact.
"""

from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


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

    @model_validator(mode="after")
    def required_fields(self):
        if self.kind == "board_receipt" and (not self.action_id or self.status is None):
            raise ValueError("board receipt requires action_id and status")
        if self.kind == "vision_observation" and not self.exercise_key:
            raise ValueError("vision observation requires exercise_key")
        return self


def apply_events(s, events):
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
            if action is None or action["status"] != "proposed":
                continue
            action.update(status=event.status, receipt_id=event.event_id)
        else:
            if event.exercise_key != f"{s.get('topic_index', 0)}:{s['state']}" or s.get("paused"):
                continue
            s["observation"] = {
                "visible_text": event.visible_text,
                "confidence": event.confidence,
                "step_complete": event.step_complete,
                "evidence_id": event.event_id,
            }
        seen.append(event.event_id)
    s["teaching_event_ids"] = seen[-100:]


def propose_question(s, decision, text):
    current_key = f"{s.get('topic_index', 0)}:{s['state']}"
    for action in s.get("board_actions", []):
        if action["status"] == "proposed" and action["exercise_key"] != current_key:
            action["status"] = "cancelled"
    if decision.reason not in {
        "start_diagnostic",
        "next_diagnostic",
        "begin_guided",
        "guided_passed",
        "student_next",
        "return_to_exercise",
    }:
        return
    s.pop("observation", None)
    # Cancel unexecuted actions when the teaching target changes.
    for action in s.get("board_actions", []):
        if action["status"] == "proposed":
            action["status"] = "cancelled"
    action = {
        "action_id": uuid4().hex,
        "kind": "write_math",
        "text": text,
        "exercise_key": f"{s.get('topic_index', 0)}:{s['state']}",
        "status": "proposed",
    }
    s["board_actions"] = (s.get("board_actions", []) + [action])[-20:]
    decision.board_actions = [dict(action)]


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
