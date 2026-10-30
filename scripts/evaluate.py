#!/usr/bin/env python3
"""Analyze exported local evidence. Never fabricates unavailable study metrics."""
import argparse
import json
from statistics import mean


def evaluate(data):
    events = data.get('events', [])
    scores = [e for e in events if e.get('type') == 'assessment']
    independent = [e for e in scores if e.get('state') == 'INDEPENDENT_PRACTICE' and not e.get('assisted')]
    usage = data.get('usage', [])
    latencies = [u['latency_ms'] for u in usage if u.get('latency_ms') is not None]
    return {
        'independent_accuracy': mean(e['correct'] for e in independent) if independent else None,
        'independent_attempts': len(independent),
        'observed_knowledge_history': data.get('knowledge', []),
        'knowledge_change_validated': None,
        'error_diagnosis_accuracy_vs_human_labels': None,
        'intervention_timing_human_rating': None,
        'one_week_retention': None,
        'memory_retrieval_accuracy_vs_labels': None,
        'mean_request_latency_ms': mean(latencies) if latencies else None,
        'estimated_api_cost_gbp': sum(u.get('estimated_cost_gbp', 0) for u in usage),
        'lesson_modes': {s['id']: s['mode'] for s in data.get('lessons', [])},
        'measurement_note': 'Null means unmeasured. Exact-bank correctness is not general teaching efficacy. Costs are estimates, not bills.'
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('export_json')
    args = parser.parse_args()
    with open(args.export_json) as f:
        print(json.dumps(evaluate(json.load(f)), ensure_ascii=False, indent=2))
