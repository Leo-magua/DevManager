#!/bin/bash
# 一键启动 DevManager + PersonalWork；保留已有 80 端口代理

cd "$(dirname "$0")"

NODE_BIN="/Users/wendy/.local/bin/node"
PERSONALWORK_DIR="/Users/wendy/AllProject/PersonalWork"
PERSONALWORK_PORT="${PERSONALWORK_PORT:-3991}"

is_port_listening() {
  local port=$1
  lsof -i :"$port" 2>/dev/null | grep -q LISTEN
}

echo "🔎 检查 DevManager (端口 81)..."
if is_port_listening 81; then
  echo "✅ DevManager 已在运行"
else
  echo "🚀 启动 DevManager (端口 81，同时托管 PersonalWork:${PERSONALWORK_PORT})..."
  nohup "$NODE_BIN" src/app.js </dev/null > server.log 2>&1 &
  sleep 2
fi

echo "🔎 检查 PersonalWork 上游 (端口 ${PERSONALWORK_PORT})..."
if is_port_listening "$PERSONALWORK_PORT"; then
  echo "✅ PersonalWork 上游已在运行"
else
  echo "⚠️  PersonalWork 上游未监听；请查看 DevManager/server.log"
fi

# 检查 80 端口反向代理：保留现有代理，不自动回退 8888
echo "🔎 检查 80 端口反向代理..."
cd /Users/wendy/AllProject/DevManager
if lsof -i :80 2>/dev/null | grep -q LISTEN; then
  echo "✅ 80 端口已有代理在运行，保留现有代理"
else
  echo "⚠️  80 端口当前未监听；如需启用 80 入口，请手动运行:"
  echo "   sudo env PROXY_PORT=80 PERSONALWORK_PORT=${PERSONALWORK_PORT} ${NODE_BIN} proxy.js"
fi

echo ""
echo "✅ 启动流程完成"
echo "  PersonalWork: http://localhost/  (经 80 代理) 或 http://localhost:${PERSONALWORK_PORT}/"
echo "  DevManager:   http://localhost:81/"

if [ "$PPID" -eq 1 ]; then
  echo "ℹ️  由 launchd 启动，保持脚本常驻以避免 KeepAlive 循环重启"
  while true; do
    sleep 3600
  done
fi
