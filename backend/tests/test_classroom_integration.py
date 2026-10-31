from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.db import Event, Knowledge, Lesson, Usage
from app.main import create_app


def test_board_delivery_requires_saved_matching_snapshot_and_is_not_assessment(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client:
        teacher = client.post('/api/teachers', json={'name': 'Integration'}).json()
        lesson = client.post(f"/api/teachers/{teacher['id']}/lessons", json={}).json()
        lid = lesson['id']
        with app.state.factory() as db:
            row = db.get(Lesson, lid)
            row.data = {**row.data, 'board_actions': [
                {'action_id': 'question', 'kind': 'write_math', 'text': 'y = x²',
                 'exercise_key': '0:ONBOARDING', 'status': 'proposed'}]}
            db.commit()
        receipt = {'event_id': 'receipt-question', 'action_id': 'question', 'status': 'executed', 'revision': 1}
        endpoint = f'/api/lessons/{lid}/board/receipts'
        assert client.post(endpoint, json={'receipts': [receipt]}).status_code == 409
        snapshot = {'format': 'banxue-board', 'revision': 1, 'queue': {'steps': [
            {'action': {'id': 'question'}, 'status': 'pending'}]}}
        client.put(f'/api/lessons/{lid}/board', json={'snapshot': snapshot})
        assert client.post(endpoint, json={'receipts': [receipt]}).status_code == 409
        snapshot['queue']['steps'][0].update(status='executed', executedRevision=1)
        client.put(f'/api/lessons/{lid}/board', json={'snapshot': snapshot})
        assert client.post(endpoint, json={'receipts': [{**receipt, 'revision': 2}]}).status_code == 409
        assert client.post(endpoint, json={'receipts': [receipt]}).status_code == 200
        assert client.post(endpoint, json={'receipts': [receipt]}).status_code == 200
        updated = client.get(f'/api/lessons/{lid}').json()
        assert updated['board_actions'][0]['status'] == 'executed'
        assert updated['state'] == lesson['state']
        with app.state.factory() as db:
            assert not list(db.scalars(select(Knowledge)))
            assert not list(db.scalars(select(Usage)))
            assert not [e for e in db.scalars(select(Event)) if e.data.get('type') == 'assessment']
        other = client.post(f"/api/teachers/{teacher['id']}/lessons", json={}).json()
        # Unknown classroom cannot receive a delivery event.
        assert other['id'] == lid
        assert client.post('/api/lessons/missing/board/receipts', json={'receipts': [receipt]}).status_code == 404


def test_malformed_snapshot_cannot_crash_receipt_endpoint(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client:
        teacher = client.post('/api/teachers', json={'name': 'Integration'}).json()
        lesson = client.post(f"/api/teachers/{teacher['id']}/lessons", json={}).json()
        lid = lesson['id']
        client.put(f'/api/lessons/{lid}/board', json={'snapshot': {'format': 'banxue-board', 'queue': 1}})
        response = client.post(f'/api/lessons/{lid}/board/receipts', json={'receipts': [
            {'event_id': 'r', 'action_id': 'a', 'status': 'executed', 'revision': 1}]})
        assert response.status_code == 409
