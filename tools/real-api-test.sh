#!/usr/bin/env bash
# 真实 API 测试入口。默认跳过；只有带 --real 才会发出真实请求。
#   bash tools/real-api-test.sh           → 跳过，退出码 0
#   bash tools/real-api-test.sh --real    → 读取凭据文件后运行 tools/real-api-test.ts
#   EG_REAL_ONLY=R01,R02 bash tools/real-api-test.sh --real → 只跑指定项，结果按 id 合并
# 凭据只放在仓库外的凭据文件（默认 /tmp/eg-test.env，权限必须是 600），变量：
#   EG_TEST_BASE_URL  EG_TEST_API_KEY  EG_TEST_MODEL  EG_TEST_ALT_MODEL
# 输出经过脱敏：Key 只显示前 3 位加 ***。
set -euo pipefail

if [[ "${1:-}" != "--real" ]]; then
  echo "真实 API 测试已跳过（需要显式传入 --real）"
  exit 0
fi

ENV_FILE="${EG_TEST_ENV_FILE:-/tmp/eg-test.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "找不到凭据文件（EG_TEST_ENV_FILE 或 /tmp/eg-test.env），未发出任何请求" >&2
  exit 2
fi
perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
if [[ "$perm" != "600" ]]; then
  echo "凭据文件权限应为 600（当前 $perm），未发出任何请求" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for v in EG_TEST_BASE_URL EG_TEST_API_KEY EG_TEST_MODEL EG_TEST_ALT_MODEL; do
  if [[ -z "${!v:-}" ]]; then
    echo "凭据文件缺少 $v，未发出任何请求" >&2
    exit 2
  fi
done

cd "$(dirname "$0")/.."
# 兜底脱敏：即使某处意外输出了 Key，也在这里替换成前 3 位加 ***
node_modules/.bin/tsx tools/real-api-test.ts 2>&1 | EG_MASK="$EG_TEST_API_KEY" perl -pe 'BEGIN { $| = 1; $k = $ENV{EG_MASK}; $m = substr($k, 0, 3) . "***" } s/\Q$k\E/$m/g'
exit "${PIPESTATUS[0]}"
