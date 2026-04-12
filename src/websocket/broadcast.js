/**
 * WebSocket 广播模块
 */
const WebSocket = require('ws');
const { shellManager } = require('./shell-manager');

// 客户端集合
const clients = new Set();
const terminalClients = new Map(); // projectId -> Set of ws

// 终端数据专用广播（注入到 shellManager，避免循环依赖）
function broadcastTerminal(projectId, data) {
  const subscribers = terminalClients.get(projectId);
  if (!subscribers) return;

  // 获取当前 offset（数据应该已经被调用者追加到缓冲区）
  const { terminalBuffer } = require('./terminal-buffer');
  const session = terminalBuffer.getSession(projectId);
  const offset = session ? session.buffer.length : 0;

  const message = JSON.stringify({
    type: 'terminal_data',
    project_id: projectId,
    data: data,
    offset: offset
  });

  subscribers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// 将广播函数注入 shellManager
shellManager.setBroadcastFn(broadcastTerminal);

// 设置 WebSocket 服务器
function setupWebSocket(wss, getTaskQueueStatus) {
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.subscribedProject = null;

    console.log('[WebSocket] 客户端连接');

    // 发送当前状态
    if (getTaskQueueStatus) {
      ws.send(JSON.stringify({
        type: 'status',
        data: getTaskQueueStatus()
      }));
    }

    // 处理客户端消息
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        // 订阅终端数据
        if (msg.type === 'subscribe_terminal' && msg.project_id) {
          // 取消之前的订阅
          if (ws.subscribedProject && terminalClients.has(ws.subscribedProject)) {
            terminalClients.get(ws.subscribedProject).delete(ws);
          }

          // 新的订阅
          ws.subscribedProject = msg.project_id;
          if (!terminalClients.has(msg.project_id)) {
            terminalClients.set(msg.project_id, new Set());
          }
          terminalClients.get(msg.project_id).add(ws);

          // 发送当前缓冲区内容（重放历史）
          const { getBuffer } = require('./terminal-buffer');
          const { data, offset } = getBuffer(msg.project_id, msg.offset || 0);
          if (data) {
            ws.send(JSON.stringify({
              type: 'terminal_data',
              project_id: msg.project_id,
              data: data,
              offset: offset
            }));
          }

          // 若该项目尚无正在运行的任务 PTY 且没有 shell，则启动持久 shell
          const { getAgentExecutor } = require('../core/agent-executor');
          const executor = getAgentExecutor();
          const hasTaskPty = executor && executor.processes[msg.project_id];
          if (!hasTaskPty && !shellManager.has(msg.project_id)) {
            shellManager.start(msg.project_id);
          }
        }

        // 取消订阅
        if (msg.type === 'unsubscribe_terminal') {
          if (ws.subscribedProject && terminalClients.has(ws.subscribedProject)) {
            terminalClients.get(ws.subscribedProject).delete(ws);
            ws.subscribedProject = null;
          }
        }

        // 向终端发送输入
        if (msg.type === 'terminal_input' && msg.project_id && msg.data) {
          const { getAgentExecutor } = require('../core/agent-executor');
          const executor = getAgentExecutor();

          // 优先发送给任务 PTY（kimi 正在运行时）
          if (executor && executor.processes[msg.project_id]) {
            const ptyProcess = executor.processes[msg.project_id];

            if (msg.data === '\u0003' || msg.data === '\x03') {
              try {
                ptyProcess.write('\x03');
                setTimeout(() => {
                  try { ptyProcess.kill('SIGINT'); } catch {}
                }, 100);
              } catch (e) {}
            } else {
              ptyProcess.write(msg.data);
            }
            return;
          }

          // 没有任务 PTY → 发给持久 shell
          if (!shellManager.has(msg.project_id)) {
            // shell 不存在则先启动
            shellManager.start(msg.project_id);
          }

          if (msg.data === '\u0003' || msg.data === '\x03') {
            // Ctrl+C：发给 shell 进程
            const proc = shellManager.getProcess(msg.project_id);
            if (proc) {
              try {
                proc.write('\x03');
                setTimeout(() => { try { proc.kill('SIGINT'); } catch {} }, 100);
              } catch {}
            }
          } else {
            shellManager.write(msg.project_id, msg.data);
          }
        }

        // 终端尺寸调整
        if (msg.type === 'terminal_resize' && msg.project_id) {
          const cols = msg.cols || 120;
          const rows = msg.rows || 40;
          shellManager.resize(msg.project_id, cols, rows);
          const { getAgentExecutor } = require('../core/agent-executor');
          const executor = getAgentExecutor();
          if (executor && executor.processes[msg.project_id]) {
            try { executor.processes[msg.project_id].resize(cols, rows); } catch {}
          }
        }
      } catch (err) {
        console.error('[WebSocket] 消息处理错误:', err.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (ws.subscribedProject && terminalClients.has(ws.subscribedProject)) {
        terminalClients.get(ws.subscribedProject).delete(ws);
      }
      console.log('[WebSocket] 客户端断开');
    });
  });
}

// 广播消息
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

module.exports = {
  setupWebSocket,
  broadcast,
  broadcastTerminal
};
