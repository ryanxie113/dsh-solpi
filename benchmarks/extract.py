#!/usr/bin/env python3
"""Extract benchmark metrics from a dsh session.v3.jsonl.zstd file.

Usage: extract.py <session.v3.jsonl.zstd>
Outputs one JSON object with request/tool/token metrics.
"""
import json
import subprocess
import sys


def main():
    path = sys.argv[1]
    raw = subprocess.run(["zstd", "-dc", path], capture_output=True, text=True).stdout
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    first_ts = None
    last_ts = None
    user_msgs = 0
    assistant_msgs = 0
    tool_calls = 0
    tool_calls_by_name: dict[str, int] = {}
    compactions_started = 0
    compaction_summaries = 0
    input_tokens = 0
    output_tokens = 0

    def ts(e):
        t = e.get("time") or e.get("data", {}).get("time")
        return t if isinstance(t, (int, float)) else None

    for e in events:
        t = e.get("type")
        tsv = ts(e)
        if tsv is not None:
            first_ts = tsv if first_ts is None else min(first_ts, tsv)
            last_ts = tsv if last_ts is None else max(last_ts, tsv)
        if t == "user/message":
            user_msgs += 1
        elif t == "assistant/message":
            assistant_msgs += 1
            msg = e.get("message") or {}
            usage = msg.get("usage") or {}
            input_tokens += usage.get("input", 0) or 0
            output_tokens += usage.get("output", 0) or 0
            # some adapters nest under different keys; probe safely
            if not usage and isinstance(msg.get("tokens"), dict):
                input_tokens += msg["tokens"].get("input", 0) or 0
                output_tokens += msg["tokens"].get("output", 0) or 0
        elif t == "tool/call":
            tool_calls += 1
            name = e.get("data", {}).get("name") or e.get("name") or "?"
            tool_calls_by_name[name] = tool_calls_by_name.get(name, 0) + 1
        elif t == "compaction/start":
            compactions_started += 1
        elif t == "compaction/summary":
            compaction_summaries += 1

    print(json.dumps({
        "events": len(events),
        "durationSec": round((last_ts - first_ts) / 1000, 1) if first_ts and last_ts else None,
        "requests": assistant_msgs,
        "userMessages": user_msgs,
        "toolCalls": tool_calls,
        "toolCallsByName": tool_calls_by_name,
        "compactionsStarted": compactions_started,
        "compactionSummaries": compaction_summaries,
        "inputTokensSeen": input_tokens or None,   # adapter-dependent; may be absent
        "outputTokensSeen": output_tokens or None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
