"""Qwen wire protocol and saved-board contracts. MockTransport is not a live Qwen test."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_core import begin, fixture_image, live_config, provider, vision_result
from test_handwriting import FakeVision, confirmation, submit

from app.main import create_app


def snapshot(revision=7):
    return {
        "format": "banxue-board",
        "version": 1,
        "width": 1600,
        "height": 1200,
        "revision": revision,
        "elements": [
            {
                "id": "student-1",
                "author": "student",
                "x": 20,
                "y": 20,
                "width": 100,
                "height": 40,
                "kind": "formula",
                "text": "6x+2",
            },
            {
                "id": "teacher-1",
                "author": "teacher",
                "x": 20,
                "y": 80,
                "width": 100,
                "height": 40,
                "kind": "formula",
                "text": "y=3x²+2x",
            },
        ],
    }


def source(revision=7):
    return {
        "kind": "whiteboard_region",
        "page_id": "main",
        "snapshot_id": f"banxue-board:v1:{revision}",
        "revision": revision,
        "author": "student",
        "element_ids": ["student-1"],
        "region": {"x": 0, "y": 0, "width": 1600, "height": 1200},
    }


def save(c, lesson, board):
    assert c.put(f"/api/lessons/{lesson['id']}/board", json={"snapshot": board}).status_code == 200


def test_qwen_vl_is_explicit_and_does_not_change_other_roles(tmp_path):
    captured = []

    def respond(request):
        payload = json.loads(request.content)
        captured.append((str(request.url), payload))
        answer = json.dumps(vision_result()) if payload["model"] == "qwen3-vl-plus" else "教师回复"
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": answer}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1100, "completion_tokens": 200},
            },
        )

    settings = live_config(
        tmp_path,
        vision_adapter="qwen_vl",
        vision_model="qwen3-vl-plus",
        vision_base_url="https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        reasoning_model="user-selected-reasoning",
    )
    original = settings.model_dump()
    with TestClient(create_app(settings, httpx.MockTransport(respond))) as c:
        _, lesson = begin(c)
        obs = submit(c, lesson)["observation"]
        assert obs["provenance"]["adapter"] == "qwen_vl"
        url, request = captured[0]
        assert url.endswith("/compatible-mode/v1/chat/completions")
        assert request["response_format"] == {"type": "json_object"}
        assert request["enable_thinking"] is False
        assert request["max_tokens"] == settings.vision_max_output_tokens
        assert "max_completion_tokens" not in request and "extra_body" not in request
        assert request["messages"][-1]["content"][-1]["image_url"] == {"url": fixture_image()}
        assert "JSON" in request["messages"][0]["content"]
        assert (
            c.post(
                f"/api/lessons/{lesson['id']}/observations/{obs['id']}/confirm",
                json={**confirmation(obs), "resolutions": {}},
            ).status_code
            == 200
        )
        assert captured[1][1]["model"] == "user-selected-reasoning"
        assert "response_format" not in captured[1][1] and "enable_thinking" not in captured[1][1]
        assert "max_completion_tokens" in captured[1][1]
        assert settings.model_dump() == original
        assert c.get(f"/api/lessons/{lesson['id']}/usage").json()["requests"][0]["usage_source"] == "provider"


@pytest.mark.parametrize("failure", ["http", "length", "schema"])
def test_qwen_failure_never_falls_back_or_retries(tmp_path, failure):
    calls = []

    def respond(request):
        calls.append(request)
        if failure == "http":
            return httpx.Response(400, json={"error": {"message": "unsupported model"}})
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": "{}" if failure == "schema" else json.dumps(vision_result())},
                        "finish_reason": "length" if failure == "length" else "stop",
                    }
                ]
            },
        )

    with TestClient(create_app(live_config(tmp_path, vision_adapter="qwen_vl"), httpx.MockTransport(respond))) as c:
        _, lesson = begin(c)
        path = f"/api/lessons/{lesson['id']}/observations"
        assert c.post(path, json={"image": fixture_image()}).status_code == 502
        assert len(calls) == 1
        usage = c.get(f"/api/lessons/{lesson['id']}/usage").json()
        assert usage["estimated_cost_gbp"] > 0
        assert len(usage["requests"]) == 1


@pytest.mark.parametrize("change", ["revision", "erase", "same_revision_edit", "new_stroke", "teacher_edit"])
def test_saved_board_changes_reject_confirmation(tmp_path, change):
    with TestClient(create_app(live_config(tmp_path), httpx.MockTransport(provider), FakeVision())) as c:
        _, lesson = begin(c)
        board = snapshot()
        save(c, lesson, board)
        obs = submit(c, lesson, source=source())["observation"]
        if change in ["revision", "teacher_edit"]:
            board["revision"] += 1
        if change == "erase":
            board["elements"] = board["elements"][1:]
        if change == "same_revision_edit":
            board["elements"][0]["text"] = "6x-2"
        if change == "new_stroke":
            board["elements"].append({**board["elements"][0], "id": "student-2"})
        save(c, lesson, board)
        path = f"/api/lessons/{lesson['id']}/observations/{obs['id']}"
        assert c.get(path).json()["stale_reason"]
        response = c.post(path + "/confirm", json={**confirmation(obs), "resolutions": {}, "board_revision": 7})
        assert response.status_code == 409
        assert c.get(f"/api/lessons/{lesson['id']}/usage").json()["requests"] == []


def test_student_region_references_and_client_revision_are_required(tmp_path):
    fake = FakeVision()
    with TestClient(create_app(live_config(tmp_path), httpx.MockTransport(provider), fake)) as c:
        _, lesson = begin(c)
        path = f"/api/lessons/{lesson['id']}/observations"
        # No persisted revision: no paid call.
        assert c.post(path, json={"image": fixture_image(), "source": source()}).status_code == 409
        save(c, lesson, snapshot())
        for patch in [{"author": "all"}, {"element_ids": ["student-1", "student-1"]}, {"revision": 7.5}]:
            assert c.post(path, json={"image": fixture_image(), "source": {**source(), **patch}}).status_code == 422
        for ids in [["teacher-1"], ["missing"]]:
            assert (
                c.post(path, json={"image": fixture_image(), "source": {**source(), "element_ids": ids}}).status_code
                == 409
            )
        assert fake.calls == 0
        obs = submit(c, lesson, source=source())["observation"]
        confirm_path = path + "/" + obs["id"] + "/confirm"
        payload = {**confirmation(obs), "resolutions": {}}
        assert c.post(confirm_path, json=payload).status_code == 409
        result = c.post(confirm_path, json={**payload, "board_revision": 7})
        assert result.status_code == 200
        assert result.json()["lesson"]["observation"]["source"]["element_ids"] == ["student-1"]


def test_intervening_turn_invalidates_even_when_state_and_topic_match(tmp_path):
    with TestClient(create_app(live_config(tmp_path), httpx.MockTransport(provider), FakeVision())) as c:
        _, lesson = begin(c)
        obs = submit(c, lesson)["observation"]
        # Same ONBOARDING/topic_index, but a new classroom turn has happened.
        after = c.post(f"/api/lessons/{lesson['id']}/turn", json={"text": "你好"}).json()["lesson"]
        assert (after["state"], after["topic_index"]) == (lesson["state"], lesson["topic_index"])
        assert (
            c.post(
                f"/api/lessons/{lesson['id']}/observations/{obs['id']}/confirm",
                json={**confirmation(obs), "resolutions": {}},
            ).status_code
            == 409
        )


def test_voice_allows_reading_but_blocks_new_recognition_and_confirmation(tmp_path):
    app = create_app(live_config(tmp_path), httpx.MockTransport(provider), FakeVision())
    with TestClient(app) as c:
        _, lesson = begin(c)
        obs = submit(c, lesson)["observation"]
        path = f"/api/lessons/{lesson['id']}/observations/{obs['id']}"
        app.state.voice_sessions[lesson["id"]] = object()
        assert c.get(path).status_code == 200
        assert "语音" in submit(c, lesson)["skipped"]
        assert c.post(path + "/confirm", json={**confirmation(obs), "resolutions": {}}).status_code == 409
        assert c.get(f"/api/lessons/{lesson['id']}/usage").json()["requests"] == []
        app.state.voice_sessions.clear()
