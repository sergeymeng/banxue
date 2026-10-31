"""Fixtures for sibling branch interfaces; no import/copy of its implementation."""

import copy
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_core import begin, configuration, turn
from test_teaching_engine import guided

from app.context import build_context
from app.db import Event, Knowledge, Lesson, Teacher
from app.main import create_app
from app.policy import BaselinePolicy, TeachingPolicy
from app.service import receive_teaching_events
from app.service import turn as service_turn
from app.teaching_contracts import apply_events, delivery_context
from app.teaching_observations import confirmed_observation


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(configuration(tmp_path))) as c:
        yield c


def reviewed():
    return {
        "id": "observation-1",
        "confirmation_event_id": "confirmation-1",
        "confirmed": True,
        "exercise_key": "0:GUIDED_PRACTICE",
        "step_complete": True,
        "source": {"kind": "whiteboard_region", "sha256": "a" * 64, "page_id": "page-1", "snapshot_id": "revision-7"},
        "image_sha256": "a" * 64,
        "uncertainty": "user_confirmed_transcription",
        "steps": [
            {"id": "step-1", "mark": "active", "text": "du/dx=999"},
            {"id": "step-2", "mark": "crossed_out", "text": "SECRET_CROSSED_OUT"},
        ],
        "visible_text": "UNTRUSTED_DERIVED_TEXT",
    }


@pytest.mark.parametrize("confidence", [0, 0.79, 0.8, 1])
@pytest.mark.parametrize("policy", [TeachingPolicy, BaselinePolicy])
def test_confidence_never_authorizes_a_legacy_observation(confidence, policy, tmp_path):
    s = {
        "state": "GUIDED_PRACTICE",
        "topic_index": 0,
        "observation": {"visible_text": "UNREVIEWED_IMAGE_TEXT", "confidence": confidence, "step_complete": True},
    }
    decision = policy().decide(s, event="board")
    assert decision.reason == "needs_confirmation"
    messages = build_context({}, s, decision, [], [], configuration(tmp_path))
    assert "UNREVIEWED_IMAGE_TEXT" not in json.dumps(messages)
    s["observation"]["confirmed"] = True  # A flag alone cannot bypass provenance/binding.
    assert policy().decide(s, event="board").reason == "needs_confirmation"


def test_review_filters_crossed_out_and_rejects_stale_incomplete_provenance(tmp_path):
    s = {"state": "GUIDED_PRACTICE", "topic_index": 0, "observation": reviewed()}
    assert confirmed_observation(s)["visible_text"] == "du/dx=999"
    decision = TeachingPolicy().decide(s, event="board")
    assert decision.reason == "completed_step" and not s.get("answer_check")
    messages = build_context({}, s, decision, [], [], configuration(tmp_path))
    payload = json.dumps(messages)
    assert "confirmation-1" in payload and "du/dx=999" in payload
    assert "SECRET_CROSSED_OUT" not in payload and "UNTRUSTED_DERIVED_TEXT" not in payload
    for key in ["id", "source", "confirmation_event_id", "exercise_key", "uncertainty"]:
        candidate = copy.deepcopy(s)
        candidate["observation"].pop(key)
        assert confirmed_observation(candidate) is None
    s["topic_index"] = 1
    assert confirmed_observation(s) is None


def test_confirmation_batch_is_atomic_and_preserves_revision():
    s = {
        "state": "GUIDED_PRACTICE",
        "topic_index": 0,
        "board_actions": [{"action_id": "action-1", "status": "proposed", "exercise_key": "0:GUIDED_PRACTICE"}],
    }
    receipt = {
        "event_id": "receipt-1",
        "kind": "board_receipt",
        "action_id": "action-1",
        "status": "executed",
        "executed_revision": 8,
    }
    bad = {
        "event_id": "bad",
        "kind": "vision_observation",
        "exercise_key": "0:GUIDED_PRACTICE",
        "observation": {"confirmed": True},
    }
    before = copy.deepcopy(s)
    with pytest.raises(ValueError):
        apply_events(s, [receipt, bad])
    assert s == before
    apply_events(s, [receipt, receipt])
    assert delivery_context(s)["board_executed"][0]["executed_revision"] == 8


async def test_reviewed_wrong_math_does_not_grade_and_gateway_sees_only_reviewed_text(client):
    teacher, lesson = guided(client)
    calls = []

    class TextGateway:
        settings = configuration(client.app.state.settings.data_dir, model_mode="live")

        async def complete(self, db, lesson_id, role, messages):
            calls.append(messages)
            return "这里常数项的导数是多少？"

    with client.app.state.factory() as db:
        row = db.get(Lesson, lesson["id"])
        before = [copy.deepcopy(k.data) for k in db.scalars(select(Knowledge))]
        receive_teaching_events(
            db,
            row,
            [
                {
                    "event_id": "review-event",
                    "kind": "vision_observation",
                    "exercise_key": "0:GUIDED_PRACTICE",
                    "observation": reviewed(),
                }
            ],
        )
        result = await service_turn(db, row, db.get(Teacher, teacher["id"]), TextGateway(), event="board")
        assert result["decision"]["reason"] == "completed_step"
        assert [k.data for k in db.scalars(select(Knowledge))] == before
        assert result["lesson"]["exercise_flow"]["step"] == 0
        assert result["decision"]["board_actions"] == []
        assert "du/dx=999" in json.dumps(calls) and "SECRET_CROSSED_OUT" not in json.dumps(calls)


async def test_compact_handwriting_handoff_resolves_durable_provenance(client):
    teacher, lesson = guided(client)

    class Demo:
        settings = client.app.state.settings

    full = reviewed()
    # Exact compact field shape emitted by the handwriting branch: no source/key.
    compact = {
        k: full[k]
        for k in [
            "id",
            "confirmation_event_id",
            "confirmed",
            "step_complete",
            "uncertainty",
            "steps",
            "visible_text",
            "image_sha256",
        ]
    }
    with client.app.state.factory() as db:
        row = db.get(Lesson, lesson["id"])
        db.add(
            Event(
                id=full["id"],
                lesson_id=row.id,
                data={
                    "type": "region_observation",
                    "status": "confirmed",
                    "observation": {"source": full["source"]},
                    "lesson_context": {"state": "GUIDED_PRACTICE", "topic_index": 0},
                    "reviewed": full,
                },
            )
        )
        db.add(
            Event(
                id=full["confirmation_event_id"],
                lesson_id=row.id,
                data={
                    "type": "observation_confirmation",
                    "source": "student_review",
                    "observation_id": full["id"],
                    "image_sha256": full["image_sha256"],
                },
            )
        )
        row.data = {**row.data, "observation": compact}
        db.commit()
        response = await service_turn(db, row, db.get(Teacher, teacher["id"]), Demo(), event="board")
        assert response["decision"]["reason"] == "completed_step"
        assert confirmed_observation(row.data)["source"]["snapshot_id"] == "revision-7"
        row.data = {**row.data, "observation": compact, "topic_index": 1}
        response = await service_turn(db, row, db.get(Teacher, teacher["id"]), Demo(), event="board")
        assert response["decision"]["reason"] == "needs_confirmation"


def test_step_board_proposals_use_evidence_and_cancel_superseded_prompts(client):
    _, lesson = guided(client)
    initial = lesson["last_decision"]["board_actions"]
    assert [a["purpose"] for a in initial] == ["question", "step_prompt"]
    old_prompt = initial[1]["action_id"]
    lesson = turn(client, lesson, "2")
    decision = lesson["last_decision"]
    assert old_prompt in decision["board_cancellations"]
    checked = decision["board_actions"][0]
    assert checked["purpose"] == "verified_step" and checked["text"] == "du/dx = 2"
    assert checked["step_index"] == 0
    assert checked["evidence_ids"] == [lesson["last_check"]["evidence_id"]]
    assert checked["status"] == "proposed" and not delivery_context(lesson)["board_executed"]
    pending = [a["action_id"] for a in lesson["board_actions"] if a["status"] == "proposed"]
    lesson = turn(client, lesson, "你说错了")
    assert set(lesson["last_decision"]["board_cancellations"]) == set(pending)


def test_independent_board_does_not_reveal_solution_and_assistance_is_recorded(client):
    _, lesson = guided(client)
    lesson = turn(client, lesson, "6(2x+3)^2")
    actions = lesson["last_decision"]["board_actions"]
    assert [a["purpose"] for a in actions] == ["question"]
    assert all("dy/dx" not in a["text"] for a in actions)
    lesson = turn(client, lesson, "恢复")
    assert not lesson["last_decision"]["board_actions"]
    lesson = turn(client, lesson, "提示")
    assert lesson["assisted"]
    assert all(
        a["purpose"] == "step_prompt" and "6x" not in a["text"] for a in lesson["last_decision"]["board_actions"]
    )


def test_newer_pending_review_blocks_older_confirmation():
    s = {"state": "GUIDED_PRACTICE", "topic_index": 0, "pending_observation_id": "new-image"}
    apply_events(
        s,
        [
            {
                "event_id": "late-review",
                "kind": "vision_observation",
                "exercise_key": "0:GUIDED_PRACTICE",
                "observation": reviewed(),
            }
        ],
    )
    assert s["pending_observation_id"] == "new-image" and "observation" not in s
    s.update(observation=reviewed(), pending_observation_id=None, latest_observation_id="new-image")
    assert confirmed_observation(s) is None


async def test_pending_review_blocks_auto_without_model_call(client):
    teacher, lesson = begin(client)
    with client.app.state.factory() as db:
        row = db.get(Lesson, lesson["id"])
        row.data = {**row.data, "state": "EXPLAINING", "pending_observation_id": "pending-1"}
        db.commit()
        result = await service_turn(db, row, db.get(Teacher, teacher["id"]), None, event="auto")
        assert result["decision"] is None and result["lesson"]["state"] == "EXPLAINING"
