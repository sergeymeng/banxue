"""Run with backend venv. Metadata inventory is not legal clearance."""
import importlib.metadata
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
lock = json.loads((root / 'frontend/package-lock.json').read_text())
frontend = [dict(path=p, version=d.get('version'), license=d.get('license', 'UNDECLARED'), dev=d.get('dev', False)) for p, d in lock['packages'].items() if p]
desktop_lock = json.loads((root / 'desktop/package-lock.json').read_text())
desktop = [dict(path=p, version=d.get('version'), license=d.get('license', 'UNDECLARED')) for p, d in desktop_lock['packages'].items() if p]
backend = []
for dist in importlib.metadata.distributions():
    m = dist.metadata
    license_id = m.get('License-Expression') or m.get('License') or 'UNDECLARED'
    backend.append(dict(name=m['Name'], version=dist.version, license=license_id[:300], classifiers=[x for x in (m.get_all('Classifier') or []) if x.startswith('License')]))
report = dict(note='Installed/locked package metadata; not a compatibility opinion. The SVG board adds no dependencies; bundled components retain their own licenses.', frontend=frontend, desktop=desktop, backend=sorted(backend, key=lambda d: d['name'].lower()))
(root / 'docs/dependency-licenses.json').write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n')
print(f'Inventoried {len(frontend)} JS lockfile entries and {len(backend)} installed Python packages, and {len(desktop)} desktop entries.')
