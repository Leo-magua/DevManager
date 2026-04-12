/**
 * 终端缓冲区管理器
 * 每个项目有独立的缓冲区，持久化任务历史（切换项目时可回看）
 */
class TerminalBuffer {
  constructor() {
    this.buffers = new Map(); // projectId -> { taskId, buffer, clients, closed, exitCode }
    this.maxSize = 500000; // 最大缓冲区 500KB
  }

  /**
   * 初始化或重用项目的终端缓冲区
   * 若已有历史内容，追加分隔符而非清空，保留完整历史
   */
  init(projectId, taskId) {
    const existing = this.buffers.get(projectId);
    if (existing) {
      // 保留历史内容，追加任务分隔符
      existing.taskId = taskId;
      existing.closed = false;
      existing.exitCode = null;
      existing.lastAccess = Date.now();
      const ts = new Date().toLocaleString('zh-CN', { hour12: false });
      const sep = `\r\n\x1b[90m${'─'.repeat(40)}\x1b[0m\r\n\x1b[36m[新任务: ${taskId} | ${ts}]\x1b[0m\r\n\r\n`;
      existing.buffer += sep;
    } else {
      this.buffers.set(projectId, {
        taskId,
        buffer: '',
        clients: new Set(),
        lastAccess: Date.now(),
        closed: false,
        exitCode: null
      });
    }
  }

  append(projectId, data) {
    const session = this.buffers.get(projectId);
    if (!session) return;

    session.buffer += data;
    session.lastAccess = Date.now();

    // 限制缓冲区大小（保留最后 500KB）
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

  /**
   * 标记终端会话结束，记录退出码
   * 保留缓冲区内容 1 小时（方便切换项目后仍可回看历史）
   */
  close(projectId, exitCode = null) {
    const session = this.buffers.get(projectId);
    if (session) {
      session.closed = true;
      session.exitCode = exitCode;
      // 延长到 60 分钟后清理（原来是 5 分钟）
      setTimeout(() => {
        this.buffers.delete(projectId);
      }, 60 * 60 * 1000);
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

function init(projectId, taskId) {
  return terminalBuffer.init(projectId, taskId);
}

function append(projectId, data) {
  return terminalBuffer.append(projectId, data);
}

function getBuffer(projectId, offset) {
  return terminalBuffer.getBuffer(projectId, offset);
}

function close(projectId, exitCode) {
  return terminalBuffer.close(projectId, exitCode);
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
