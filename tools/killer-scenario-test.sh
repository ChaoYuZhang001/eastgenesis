#!/usr/bin/env bash
# 杀手场景：把下载文件夹里最近 30 天的 PDF 按主题分类。默认跳过；只有带 --real 才执行。
#   bash tools/killer-scenario-test.sh          → 跳过，退出码 0
#   bash tools/killer-scenario-test.sh --real   → 编译 eg-mcp-files，在临时目录的夹具副本上跑完整流程，报告写入 docs/KILLER_SCENARIO_REPORT.md
# 工具始终是真实的 MCP 子进程，只操作临时目录，不碰真实的 ~/Downloads。
# 模型：凭据文件（默认 /tmp/eg-test.env，权限必须是 600，变量 EG_TEST_BASE_URL、EG_TEST_API_KEY、EG_TEST_MODEL）
# 有效时用真实模型，否则用确定性模拟模型。输出里的 Key 只显示前 3 位加 ***。
set -euo pipefail

if [[ "${1:-}" != "--real" ]]; then
  echo "杀手场景已跳过（需要显式传入 --real）"
  exit 0
fi

cd "$(dirname "$0")/.."

ENV_FILE="${EG_TEST_ENV_FILE:-/tmp/eg-test.env}"
if [[ -f "$ENV_FILE" ]]; then
  perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  if [[ "$perm" == "600" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  else
    echo "凭据文件权限应为 600（当前 $perm），忽略它，改用模拟模型" >&2
  fi
fi
# 只认这三个变量；其余 Key 不传给脚本
unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY DASHSCOPE_API_KEY MOONSHOT_API_KEY TYPESAFE_API_KEY || true

echo "编译 eg-mcp-files…"
# EG_CARGO_FLAGS：额外的 cargo 参数（例如 --offline），按空格拆分
# shellcheck disable=SC2086
cargo build --quiet ${EG_CARGO_FLAGS:-} -p eg-core --bin eg-mcp-files

MASK_KEY="${EG_TEST_API_KEY:-}"
node_modules/.bin/tsx tools/killer-scenario.ts 2>&1 | EG_MASK="$MASK_KEY" perl -pe 'BEGIN { $| = 1; $k = $ENV{EG_MASK}; $m = substr($k, 0, 3) . "***" } s/\Q$k\E/$m/g if length $k'
exit "${PIPESTATUS[0]}"
