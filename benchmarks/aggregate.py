#!/usr/bin/env python3
"""Aggregate N benchmark runs of the same task into mean ± range + behavior counters.

Usage:
    python3 benchmarks/aggregate.py <results-substring> [substring2 ...]

Each benchmark run leaves a directory benchmarks/results/<task>-<group>-<HHMMSS>.
Telemetry (events.jsonl) is sliced by [dir.mtime - duration, dir.mtime] so each
run only counts its own events even when runs share the telemetry file.
"""
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
import os

RESULTS = Path(__file__).parent / 'results'
TELEMETRY = Path.home()  # replaced below


def load_events():
    events = []
    src = Path(__file__).resolve().parent.parent / '.dsh-probe' / 'sol-pi' / 'telemetry' / 'events.jsonl'
    if not src.exists():
        sys.exit(f'telemetry not found: {src}')
    for line in src.read_text().splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            dt = datetime.fromisoformat(e['t'].replace('Z', '+00:00'))
            if dt.tzinfo is not None:
                dt = dt.astimezone().replace(tzinfo=None)  # local naive
            e['_dt'] = dt
        except (KeyError, ValueError):
            continue
        events.append(e)
    return events


def parse_driver_wall(stdout_log: Path):
    m = re.search(r'wall=(\d+(?:\.\d+)?)s', stdout_log.read_text()[-2000:])
    return float(m.group(1)) if m else None


def slice_events(events, start_dt, end_dt):
    return [e for e in events if start_dt <= e['_dt'] <= end_dt]


def summarize_run(events):
    gates = [e for e in events if e['kind'] == 'occ-gate']
    epr_applied = [e for e in events if e['kind'] == 'epr-applied']
    reasons = Counter(e.get('reason') for e in gates)
    af = [e for e in events if e['kind'] == 'af-then-run']
    skips = Counter(e.get('reason') for e in events if e['kind'] == 'epr-skip')
    epochs = len([e for e in events if e['kind'] == 'occ-result'])
    return {
        'requests_gate_checks': len(gates),
        'compaction_decisions': dict(reasons),
        'epochs_landed': epochs,
        'epr_applied': len(epr_applied),
        'af_then_run': dict(Counter(e['status'] for e in af)),
        'epr_skip': dict(skips),
    }


def main():
    patterns = sys.argv[1:] or sys.exit('usage: aggregate.py <name-substring> [...]')
    events = load_events()
    # group matching result dirs by task+group prefix, ordered by mtime
    dirs = sorted([d for d in RESULTS.iterdir() if d.is_dir()], key=lambda d: os.path.getmtime(d))
    matched = {}
    for pat in patterns:
        hits = [d for d in dirs if pat in d.name]
        if not hits:
            sys.exit(f'no results match: {pat}')
        matched[pat] = hits

    for pat, hits in matched.items():
        print(f'\n=== {pat}: {len(hits)} run(s) ===')
        walls = []
        reqs = []
        per_run_af_succeeded = []
        merged_summary = None
        for i, d in enumerate(hits):
            sl = d / 'stdout.log'
            metrics_file = d / 'metrics.json'
            wall = rq = None
            if metrics_file.exists():
                try:
                    mj = json.loads(metrics_file.read_text())
                    wall = float(mj.get('durationSec'))
                    rq = int(mj.get('requests'))
                except (ValueError, KeyError, TypeError):
                    pass
            if wall is None:
                wall = parse_driver_wall(sl) if sl.exists() else None
                driver = RESULTS.parent / f'{d.name}-driver.log'
                if wall is None and driver.exists():
                    wall = parse_driver_wall(driver)
            dur = wall or 300.0
            import datetime as _dt
            start = datetime.fromtimestamp(os.path.getmtime(d)) - _dt.timedelta(seconds=dur + 90)
            end = datetime.fromtimestamp(os.path.getmtime(d))
            ev = slice_events(events, start, end)
            s = summarize_run(ev)
            walls.append(wall)
            reqs.append(rq)
            fused_ok = s['af_then_run'].get('succeeded', 0)
            per_run_af_succeeded.append(fused_ok)
            print(f"run{i+1} {d.name[-6:]}: wall={wall}s requests={rq} "
                  f"af={s['af_then_run']} epochs={s['epochs_landed']} "
                  f"eprApplied={s['epr_applied']} gates={s['compaction_decisions']}")
        ok_walls = [w for w in walls if w is not None]
        ok_reqs = [r for r in reqs if r is not None]
        def fmt(vals):
            vals = [v for v in vals if v is not None]
            if not vals:
                return 'n/a'
            return f"{sum(vals)/len(vals):.1f} [{min(vals):.1f}–{max(vals):.1f}]"
        print(f"\n  wall(s): {fmt(ok_walls)}")
        print(f"  requests: {fmt(ok_reqs)}")
        print(f"  af_then_run succeeded/run: {fmt(per_run_af_succeeded)}")


if __name__ == '__main__':
    main()
