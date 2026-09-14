#!/usr/bin/env bash
# Benchmark runner for solpi-dsh A/B comparison.
# Usage: run.sh <taskName> <group vanilla|solpi>
# Requires: DSH home at repo .dsh-probe, gateway reachable via env proxy.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

TASK="$1"; GROUP="${2:-vanilla}"
case "$GROUP" in
  vanilla) PROFILE="bench-vanilla" ;;
  solpi)   PROFILE="headless" ;;
  *) echo "bad group"; exit 2 ;;
esac

export DSH_HOME="$PWD/.dsh-probe"
export SOLPI_DSH_ROOT="$HOME/tools/deepseek-harness"
export SOLPI_QWEN_PROXY_DUMMY_KEY=none

OUT="$PWD/benchmarks/results/${TASK}-${GROUP}-$(date +%H%M%S)"
mkdir -p "$OUT"

SESS_ROOT="$DSH_HOME/sessions"
before=$(find "$SESS_ROOT" -name "session.v3.jsonl.zstd" 2>/dev/null | sort)

echo "== preflight: gateway (via proxyjump, like the runtime)"
curl -s -o /dev/null -m 8 -x "${HTTP_PROXY:-http://proxyjump.nioint.com:8080}" http://10.129.165.101:30000/v1/models || { echo "gateway DOWN even via proxy"; exit 3; }
echo "== running task=$TASK group=$GROUP profile=$PROFILE"

cd ~/tools/deepseek-harness
START=$(date +%s)
set +e
node --import tsx/esm apps/cli/src/bin.ts --profile "$PROFILE" \
  --patch "$OLDPWD/.live-llm-local.yml" \
  "$(cat "$OLDPWD/benchmarks/tasks/$TASK.md")" \
  > "$OUT/stdout.log" 2>&1
RC=$?
set -e
END=$(date +%s)
echo "exit=$RC wall=$((END-START))s"

after=$(find "$SESS_ROOT" -name "session.v3.jsonl.zstd" 2>/dev/null | sort)
new=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
if [ -z "${new:-}" ]; then echo "NO NEW SESSION FOUND"; exit 4; fi
cp "$new" "$OUT/session.v3.jsonl.zstd"
python3 "$OLDPWD/benchmarks/extract.py" "$new" > "$OUT/metrics.json"
cat "$OUT/metrics.json"
grep -c "solpi-dsh" "$OUT/stdout.log" >/dev/null 2>&1 && grep -m2 "solpi-dsh" "$OUT/stdout.log" > "$OUT/plugin-banner.txt" || true
echo "== saved $OUT"
