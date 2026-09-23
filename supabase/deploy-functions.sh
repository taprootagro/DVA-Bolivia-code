#!/usr/bin/env bash
# =============================================================================
# TaprootAgro — 一键部署全部 Edge Functions 到指定 Supabase 项目（显式 project-ref）
# =============================================================================
# 位置：与本目录下 migrations/001_init.sql（数据库一键建表）配套使用：
#   - 001_init.sql  → 在 Dashboard SQL Editor 执行（PostgreSQL）
#   - 本脚本        → 在本机执行，把 supabase/functions/* 推到云端
#
# 使用前必读：
#   1. 已安装 Supabase CLI（或 Node + npx，见下方 USE_NPX）
#   2. 已执行：supabase login（或 npx supabase login），使用 Personal Access Token
#   3. 传入目标项目的 Reference ID：第一个参数，或环境变量 SUPABASE_PROJECT_REF
#   4. 在「项目根目录」（含 package.json、supabase/ 的那一层）执行本脚本；
#      或任意路径：bash supabase/deploy-functions.sh <PROJECT_REF>
#   5. supabase/config.toml 为各函数声明 index.tsx 入口；部署使用 --use-api 在云端打包，无需本机 Docker。
#
# 多租户 / 多客户：每次部署对应当前客户 ref，无需依赖 supabase link 的本地状态。
# 可选旧流程：仍可先 supabase link，但本脚本一律使用 --project-ref，与 link 无关。
#
# Windows：请用 Git Bash 或 WSL 执行，勿用旧版 cmd。
# =============================================================================
set -euo pipefail

usage() {
  cat <<'EOF'
用法:
  ./supabase/deploy-functions.sh <PROJECT_REF>
或:
  SUPABASE_PROJECT_REF=<PROJECT_REF> ./supabase/deploy-functions.sh

环境变量:
  SUPABASE_PROJECT_REF  与第一个参数二选一（参数优先）
  USE_NPX=1             使用 npx supabase（无需全局安装 supabase CLI）

示例:
  ./supabase/deploy-functions.sh abcdefghijklmnop
  USE_NPX=1 ./supabase/deploy-functions.sh abcdefghijklmnop
EOF
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF="${1:-}"
if [ -z "$REF" ]; then
  REF="${SUPABASE_PROJECT_REF:-}"
fi
if [ -z "$REF" ]; then
  echo "[deploy-functions] 错误：缺少 PROJECT_REF。"
  echo ""
  usage
  exit 1
fi

if [ "${USE_NPX:-0}" = "1" ]; then
  if ! command -v npx >/dev/null 2>&1; then
    echo "[deploy-functions] 错误：USE_NPX=1 需要已安装 Node.js（npx）。"
    exit 1
  fi
  CLI=(npx supabase)
else
  if ! command -v supabase >/dev/null 2>&1; then
    echo "[deploy-functions] 错误：未找到 supabase 命令。请先安装 Supabase CLI，或设置 USE_NPX=1。"
    exit 1
  fi
  CLI=(supabase)
fi

# 部署函数：根据第二个参数决定是否附加 --no-verify-jwt
# 约定：verify=on   → 启用网关 JWT 校验（chat-supabase / merchant-bind-resolve / merchant-bind-qr-url）
#       verify=off  → 关闭网关 JWT 校验（server；以及 ai-vision-proxy，见 config.toml 注释 / ES256 网关问题）
supabase_deploy() {
  local name="$1"
  local verify="$2"
  if [ "$verify" = "off" ]; then
    "${CLI[@]}" functions deploy "$name" --project-ref "$REF" --no-verify-jwt --use-api
  else
    "${CLI[@]}" functions deploy "$name" --project-ref "$REF" --use-api
  fi
}

# name|verify 二元组；verify=on 的函数走网关 JWT 校验
FUNCS=(
  "server|off"
  "ai-vision-proxy|off"
  "chat-supabase|on"
  "merchant-bind-resolve|on"
  "merchant-bind-qr-url|on"
)

echo "[deploy-functions] 项目根目录: $ROOT"
echo "[deploy-functions] project-ref: $REF"
echo "[deploy-functions] 将部署（函数|verify_jwt）:"
for item in "${FUNCS[@]}"; do echo "  - $item"; done
echo ""

for item in "${FUNCS[@]}"; do
  name="${item%%|*}"
  verify="${item##*|}"
  if [ "$verify" = "off" ]; then
    echo ">>> functions deploy $name --project-ref $REF --no-verify-jwt --use-api"
  else
    echo ">>> functions deploy $name --project-ref $REF --use-api  (verify_jwt=on)"
  fi
  supabase_deploy "$name" "$verify"
done

echo ""
echo "[deploy-functions] 全部完成。请到 Dashboard → Edge Functions → Secrets 配置密钥（见 farmer-developer/SUPABASE_CN.md）。"
