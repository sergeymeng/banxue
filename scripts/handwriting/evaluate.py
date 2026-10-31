"""Collect real API outputs or compare saved outputs with the small synthetic corpus.
No mock prediction is ever labelled a live measurement. No automatic paid retries.
"""
import argparse
import base64
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def normalize(value):
    return ''.join(value.split())


def compare(case, observation):
    expected, actual = case['expected'], observation['steps']
    differences = []
    if len(expected) != len(actual):
        differences.append({'kind': 'step_count_or_grouping', 'expected': len(expected), 'actual': len(actual)})
    for i, (want, got) in enumerate(zip(expected, actual)):
        for field in ['text', 'expressions', 'mark']:
            left, right = want[field], got[field]
            if field == 'expressions':
                left, right = list(map(normalize, left)), list(map(normalize, right))
            elif field == 'text':
                left, right = normalize(left), normalize(right)
            if left != right:
                differences.append({'step': i + 1, 'kind': field, 'expected': want[field], 'actual': got[field],
                                    'review_status': 'needs_human_review'})
    return differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--predictions', type=Path, help='Saved JSON with mode and cases; does not call a provider')
    parser.add_argument('--collect-live', action='store_true', help='Uses selected server model and its GBP budgets')
    parser.add_argument('--base-url', default='http://127.0.0.1:8000')
    parser.add_argument('--lesson-id', help='Use a dedicated active test lesson; never a student lesson')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'docs/handwriting-evaluation/manifest.json').read_text())
    if bool(args.predictions) == args.collect_live:
        parser.error('Choose either --predictions or --collect-live')
    if args.collect_live and not args.lesson_id:
        parser.error('--collect-live requires --lesson-id')
    report = {'created_at': datetime.now(timezone.utc).isoformat(), 'dataset': 'synthetic-v1',
              'mode': 'live' if args.collect_live else 'unknown', 'cases': [],
              'note': 'Literal differences require human review; equivalent LaTeX/grouping may differ. No calibrated accuracy.'}
    if args.predictions:
        saved = json.loads(args.predictions.read_text())
        report['mode'] = saved.get('mode', 'unknown')
        predictions = {c['id']: c for c in saved['cases']}
    else:
        predictions = {}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(base_url=args.base_url, timeout=120) as client:
        if args.collect_live:
            cfg = client.get('/api/config'); cfg.raise_for_status()
            if cfg.json()['mode'] != 'live':
                parser.error('Server is in demo mode; no live evaluation is possible')
        for i, case in enumerate(manifest['cases']):
            binary = (ROOT / case['image']).read_bytes()
            if hashlib.sha256(binary).hexdigest() != case['sha256']:
                raise ValueError('Fixture hash changed; regenerate manifest and review labels')
            if args.collect_live:
                if i: time.sleep(20)  # Respect server cooldown; do not retry errors.
                response = client.post(f'/api/lessons/{args.lesson_id}/observations', json={
                    'image': 'data:image/png;base64,' + base64.b64encode(binary).decode(),
                    'source': {'kind': 'fixture', 'label': case['id']}, 'trigger': 'explicit'})
                body = response.json()
                entry = {'id': case['id'], 'http_status': response.status_code,
                         'observation': body.get('observation'),
                         'error': body.get('detail') or body.get('skipped')}
            else:
                entry = predictions.get(case['id'], {'id': case['id'], 'status': 'not_run'})
            entry = {**entry, 'sha256': case['sha256'], 'tags': case['tags']}
            if entry.get('observation'):
                entry['differences'] = compare(case, entry['observation'])
                entry['review_status'] = 'needs_human_review'
            report['cases'].append(entry)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        if args.collect_live:
            usage = client.get(f'/api/lessons/{args.lesson_id}/usage'); usage.raise_for_status()
            report['lesson_usage'] = usage.json()
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
