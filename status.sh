#!/bin/bash
# 查看所有服务运行状态

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  服务状态"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

NODE_BIN="/Users/wendy/.local/bin/node"
PERSONALWORK_PORT="${PERSONALWORK_PORT:-3991}"

check_port() {
  local port=$1
  local name=$2
  if lsof -i :$port 2>/dev/null | grep -q LISTEN; then
    echo "  ✅ $name (端口 $port)"
  else
    echo "  ❌ $name (端口 $port)"
  fi
}

check_port 80 "反向代理"
check_port 81 "DevManager"
check_port "$PERSONALWORK_PORT" "PersonalWork 前端"

echo ""
echo "访问地址:"
echo "  http://localhost/        → PersonalWork 主页面"
echo "  http://localhost:81/     → DevManager 后台调度"
echo ""
