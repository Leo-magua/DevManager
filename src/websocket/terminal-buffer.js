/**
 * 终端缓冲区管理器
 */
class TerminalBuffer {
  constructor() {
    this.buffers = new Map(); // projectId -> { taskId, buffer, clients }
    this.maxSize = 500000; // 最大缓冲区 500KB
  }

  init(projectId, taskId) {
    this.buffers.set(projectId, {
      taskId,
      buffer: '',
      clients: new Set(),
      lastAccess: Date.now()
    });
  }

  append(projectId, data) {
    const session = this.buffers.get(projectId);
    if (!session) return;
    
    session.buffer += data;
    session.lastAccess = Date.now();
    
    // 限制缓冲区大小
    if (session.buffer.length > this.maxSize) {
      session.buffer = session.buffer.slice(-this.maxSize);
    }
  }

  getBuffer(projectId, offset = 0) {
    const session = this.buffers.get(projectId);
    if (!session) return { data: '', offset: 0 };
    
    session.lastAccess = Date.now();
    
    if (offset >= session.buffer.length) {
      return { data: '', offset: session.buffer.length };
    }
    
    return {
      data: session.buffer.slice(offset),
      offset: session.buffer.length
    };
  }

  close(projectId) {
    const session = this.buffers.get(projectId);
    if (session) {
      session.closed = true;
      // 5分钟后清理
      setTimeout(() => {
        this.buffers.delete(projectId);
      }, 5 * 60 * 1000);
    }
  }

  isActive(projectId) {
    const session = this.buffers.get(projectId);
    return session && !session.closed;
  }

  getSession(projectId) {
    return this.buffers.get(projectId);
  }
}

const terminalBuffer = new TerminalBuffer();

// 包装函数便于外部调用
function init(projectId, taskId) {
  return terminalBuffer.init(projectId, taskId);
}

function append(projectId, data) {
  return terminalBuffer.append(projectId, data);
}

function getBuffer(projectId, offset) {
  return terminalBuffer.getBuffer(projectId, offset);
}

function close(projectId) {
  return terminalBuffer.close(projectId);
}

function isActive(projectId) {
  return terminalBuffer.isActive(projectId);
}

function getSession(projectId) {
  return terminalBuffer.getSession(projectId);
}

module.exports = {
  terminalBuffer,
  init,
  append,
  getBuffer,
  close,
  isActive,
  getSession
};
