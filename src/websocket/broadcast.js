/**
 * WebSocket 广播模块
 */
const WebSocket = require('ws');

// 客户端集合
const clients = new Set();
const terminalClients = new Map(); // projectId -> Set of ws

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
          
          // 发送当前缓冲区内容
          const { getBuffer } = require('./terminal-buffer');
          const { data, offset } = getBuffer(msg.project_id, msg.offset || 0);
          ws.send(JSON.stringify({
            type: 'terminal_data',
            project_id: msg.project_id,
            data: data,
            offset: offset
          }));
        }
        
        // 取消订阅
        if (msg.type === 'unsubscribe_terminal') {
          if (ws.subscribedProject && terminalClients.has(ws.subscribedProject)) {
            terminalClients.get(ws.subscribedProject).delete(ws);
            ws.subscribedProject = null;
          }
        }
        
        // 向终端发送输入（交互式命令）
        if (msg.type === 'terminal_input' && msg.project_id && msg.data) {
          const { getAgentExecutor } = require('../core/agent-executor');
          const executor = getAgentExecutor();
          if (executor && executor.processes[msg.project_id]) {
            executor.processes[msg.project_id].write(msg.data);
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

// 终端数据专用广播
function broadcastTerminal(projectId, data) {
  const subscribers = terminalClients.get(projectId);
  if (!subscribers) return;
  
  const message = JSON.stringify({
    type: 'terminal_data',
    project_id: projectId,
    data: data
  });
  
  subscribers.forEach(ws => {
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
