/**
 * 持久化 Shell 管理器
 * 每个项目维护一个独立的交互式 shell 进程（bash）
 * 在没有开发任务运行时为用户提供可交互的终端
 */
const pty = require('node-pty');
const { getConfig } = require('../config');
const terminalBuffer = require('./terminal-buffer');

class ShellManager {
  constructor() {
    // projectId -> { ptyProcess, paused }
    this.shells = new Map();
    this._broadcastTerminal = null; // 由 broadcast.js 注入
  }

  /** 由 broadcast.js 在初始化时注入广播函数（避免循环依赖） */
  setBroadcastFn(fn) {
    this._broadcastTerminal = fn;
  }

  _broadcast(projectId, data) {
    if (this._broadcastTerminal) {
      this._broadcastTerminal(projectId, data);
    }
  }

  _getProjectPath(projectId) {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    return project ? project.path : null;
  }

  /**
   * 为项目启动持久 shell（如果尚未启动）
   * @returns {boolean} 是否成功
   */
  start(projectId) {
    if (this.shells.has(projectId)) return true;

    const projectPath = this._getProjectPath(projectId);
    if (!projectPath) {
      console.warn(`[ShellManager] 找不到项目路径: ${projectId}`);
      return false;
    }

    const shell = process.env.SHELL || '/bin/bash';
    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' }
      });
    } catch (err) {
      console.error(`[ShellManager] 启动 shell 失败 (${projectId}):`, err.message);
      return false;
    }

    const entry = { ptyProcess, paused: false };
    this.shells.set(projectId, entry);

    // 初始化/追加缓冲区（保留历史）
    terminalBuffer.init(projectId, 'shell');

    ptyProcess.onData((data) => {
      if (entry.paused) return;
      terminalBuffer.append(projectId, data);
      this._broadcast(projectId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.shells.delete(projectId);
      const msg = `\r\n\x1b[90m[Shell 进程已退出 (${exitCode})]\x1b[0m\r\n`;
      terminalBuffer.append(projectId, msg);
      this._broadcast(projectId, msg);
      console.log(`[ShellManager] Shell 退出: ${projectId} (code=${exitCode})`);
    });

    console.log(`[ShellManager] 已启动 shell: ${projectId} → ${projectPath}`);
    return true;
  }

  /**
   * 暂停 shell 输出（任务执行期间调用，避免与任务输出混合）
   */
  pause(projectId) {
    const entry = this.shells.get(projectId);
    if (entry) {
      entry.paused = true;
      console.log(`[ShellManager] Shell 已暂停: ${projectId}`);
    }
  }

  /**
   * 恢复 shell 输出（任务结束后调用）
   */
  resume(projectId) {
    const entry = this.shells.get(projectId);
    if (entry) {
      entry.paused = false;
      const sep = `\r\n\x1b[90m─── Shell 已恢复 ──────────────────────────\x1b[0m\r\n`;
      terminalBuffer.append(projectId, sep);
      this._broadcast(projectId, sep);
      // 发送回车让 shell 重新显示提示符
      entry.ptyProcess.write('\r');
      console.log(`[ShellManager] Shell 已恢复: ${projectId}`);
    } else {
      // shell 在任务期间被关闭了，重新启动
      this.start(projectId);
    }
  }

  /**
   * 停止项目的 shell
   */
  stop(projectId) {
    const entry = this.shells.get(projectId);
    if (entry) {
      try { entry.ptyProcess.kill('SIGTERM'); } catch {}
      this.shells.delete(projectId);
      console.log(`[ShellManager] Shell 已停止: ${projectId}`);
    }
  }

  /**
   * 向 shell 写入数据
   * @returns {boolean} 是否写入成功
   */
  write(projectId, data) {
    const entry = this.shells.get(projectId);
    if (entry) {
      // 即便 paused 状态，也允许用户写入（例如 Ctrl+C 中断正在运行的命令）
      entry.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  /**
   * 调整 shell 终端尺寸
   */
  resize(projectId, cols, rows) {
    const entry = this.shells.get(projectId);
    if (entry) {
      try { entry.ptyProcess.resize(cols, rows); } catch {}
    }
  }

  has(projectId) {
    return this.shells.has(projectId);
  }

  getProcess(projectId) {
    return this.shells.get(projectId)?.ptyProcess || null;
  }
}

const shellManager = new ShellManager();

module.exports = {
  shellManager,
  getShellManager: () => shellManager
};
