#!/usr/bin/env bash
# SoL-Pi × DeepSeek Harness 四机制测试启动器
# 用法:
#   ./solpi-test.sh web                       # 浏览器 UI（四机制全栈，自动开浏览器）
#   LONG=long PORT=8787 ./solpi-test.sh web   # 长任务档：OCC 参数调敏，自然任务可观察压缩
#   WEB_NO_OPEN=1 ./solpi-test.sh web         # 不自动开浏览器
#   ./solpi-test.sh tui                       # 交互式终端（四机制全栈）
#   ./solpi-test.sh hot "<task>"              # 无头单轮（OCC 调敏）
#   ./solpi-test.sh run "<task>"              # 无头单轮（常规参数）
#   ./solpi-test.sh base "<task>"             # 基线对照（无 SoL-Pi 插件）
set -euo pipefail
REPO=<REPO_ROOT>
DSH=~/tools/deepseek-harness
export SOLPI_QWEN_PROXY_DUMMY_KEY=${SOLPI_QWEN_PROXY_DUMMY_KEY:-none}
# Official-grade anchoring: tell the plugin where the running dsh lives
# (monorepo checkout here; auto-detection covers installed layouts).
export SOLPI_DSH_ROOT=${SOLPI_DSH_ROOT:-$HOME/tools/deepseek-harness}
export DSH_HOME="$REPO/.dsh-probe"
MODE="${1:-tui}"; shift || true

case "$MODE" in
  web)
    ov="phase-e-web.yml"; [[ -n "${LONG:-}" ]] && ov="phase-e-web-${LONG}.yml"
    [[ -f "$REPO/packages/solpi-dsh/$ov" ]] || { echo "overlay missing: $ov"; exit 66; }
    extra=(--patch "$REPO/packages/solpi-dsh/$ov")
    [[ -n "${PORT:-}" ]] && extra+=(--port "$PORT")
    [[ -n "${WEB_NO_OPEN:-}" ]] && extra+=(--no-open)
    exec pnpm --dir "$DSH" dsh --profile web "${extra[@]}" "$@"
    ;;
  tui)
    exec pnpm --dir "$DSH" dsh --profile tui \
      --patch "$REPO/packages/solpi-dsh/cordis.phase-e.yml" "$@"
    ;;
  hot)
    exec pnpm --dir "$DSH" dsh --profile headless \
      --patch "$REPO/packages/solpi-dsh/cordis.phase-e-hot.yml" "${1:?usage: solpi-test.sh hot \"<task>\"}"
    ;;
  run)
    exec pnpm --dir "$DSH" dsh --profile headless \
      --patch "$REPO/packages/solpi-dsh/cordis.phase-e.yml" "${1:?usage: solpi-test.sh run \"<task>\"}"
    ;;
  base)
    exec pnpm --dir "$DSH" dsh --profile headless \
      --patch "$REPO/packages/solpi-dsh/cordis.phase-c-baseline.yml" "${1:?usage: solpi-test.sh base \"<task>\"}"
    ;;
  *)
    echo "unknown mode: $MODE (web|tui|hot|run|base)"; exit 64
    ;;
esac
