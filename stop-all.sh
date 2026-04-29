#!/bin/bash
# 一键停止所有服务

echo "🛑 停止所有服务..."

NODE_BIN="/Users/wendy/.local/bin/node"
PERSONALWORK_PORT="${PERSONALWORK_PORT:-3991}"

stop_port() {
  local port=$1
  for pid in $(lsof -ti tcp:"$port" 2>/dev/null); do
    kill "$pid" 2>/dev/null
  done
}

pkill -f "node src/app.js" 2>/dev/null
pkill -f "node proxy.js" 2>/dev/null
pkill -f "python3 -m http.server 8080" 2>/dev/null
pkill -f "vite preview.*--port 8080" 2>/dev/null
pkill -f "python3 -m http.server ${PERSONALWORK_PORT}" 2>/dev/null
pkill -f "vite .*--port ${PERSONALWORK_PORT}" 2>/dev/null
pkill -f "serve-static-spa.js .*--port ${PERSONALWORK_PORT}" 2>/dev/null
stop_port 8080
stop_port "$PERSONALWORK_PORT"

sleep 1

echo "✅ 已停止"
echo ""
lsof -i :80 2>/dev/null | grep LISTEN || echo "  80 端口: 已释放"
lsof -i :8888 2>/dev/null | grep LISTEN || echo "  8888 端口: 已释放"
lsof -i :81 2>/dev/null | grep LISTEN || echo "  81 端口: 已释放"
lsof -i :"$PERSONALWORK_PORT" 2>/dev/null | grep LISTEN || echo "  ${PERSONALWORK_PORT} 端口: 已释放"
