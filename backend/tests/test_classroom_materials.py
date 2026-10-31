from io import BytesIO

from fastapi.testclient import TestClient
from reportlab.pdfgen.canvas import Canvas
from sqlalchemy import select

from app.config import Settings
from app.db import MaterialInk
from app.main import create_app


def test_material_pages_are_isolated_revisioned_exported_and_deleted(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    buf = BytesIO()
    pdf = Canvas(buf)
    for text in ("Page one", "Page two"):
        pdf.drawString(50, 500, text)
        pdf.showPage()
    pdf.save()
    with TestClient(app) as client:
        tid = client.post('/api/teachers', json={'name': 'Materials'}).json()['id']
        other = client.post('/api/teachers', json={'name': 'Other'}).json()['id']
        lid = client.post(f'/api/teachers/{tid}/lessons', json={}).json()['id']
        did = client.post(f'/api/teachers/{tid}/documents', files={'file': ('lesson.pdf', buf.getvalue())}).json()['id']
        file = f'/api/teachers/{tid}/documents/{did}/file'
        assert client.get(file).content.startswith(b'%PDF')
        assert client.get(file.replace(tid, other)).status_code == 404
        endpoint = f'/api/lessons/{lid}/documents/{did}/pages/1/ink'
        assert client.get(endpoint).json() == {'revision': 0, 'strokes': []}
        stroke = {'id': 'test', 'color': '#202632', 'width': .003, 'points': [{'x': .1, 'y': .2}, {'x': .3, 'y': .4}]}
        body = {'revision': 0, 'strokes': [stroke]}
        assert client.put(endpoint, json=body).json()['revision'] == 1
        assert client.put(endpoint, json=body).json()['revision'] == 1  # Lost response can be retried.
        assert client.put(endpoint, json={'revision': 0, 'strokes': []}).status_code == 409
        assert client.get(endpoint.replace('/pages/1/', '/pages/2/')).json()['strokes'] == []
        assert client.get(endpoint.replace('/pages/1/', '/pages/3/')).status_code == 404
        foreign_lid = client.post(f'/api/teachers/{other}/lessons', json={}).json()['id']
        assert client.get(endpoint.replace(lid, foreign_lid)).status_code == 404
        assert client.put(f'/api/lessons/{lid}/classroom', json={'document_id': did, 'page': 2}).status_code == 200
        restored = client.post(f'/api/teachers/{tid}/lessons', json={}).json()
        assert restored['classroom'] == {'document_id': did, 'page': 2}
        exported = client.get(f'/api/teachers/{tid}/export').json()
        assert exported['material_annotations'][0]['strokes'] == [stroke]
        assert exported['material_annotations'][0]['page'] == 1
        assert client.put(endpoint, json={'revision': 1, 'strokes': [{**stroke, 'points': [{'x': 2, 'y': 0}]}]}).status_code == 422
        assert client.put(endpoint, json={'revision': 1, 'strokes': [stroke, stroke]}).status_code == 422
        client.delete(f'/api/teachers/{tid}')
        with app.state.factory() as db:
            assert list(db.scalars(select(MaterialInk))) == []
        assert client.get(file).status_code == 404
