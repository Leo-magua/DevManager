/**
 * 任务监控器 - AI兜底监测
 * 
 * 功能：
 * 1. 每5分钟检查一次执行中的任务
 * 2. 检测是否有kimi进程在运行
 * 3. 检查任务是否超时（25分钟）
 * 4. 如果检测到任务已完成但状态未更新，自动修复
 */
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getConfig } = require('../config');

const CHECK_INTERVAL = 5 * 60 * 1000; // 5分钟
const TASK_TIMEOUT = 25 * 60 * 1000;  // 25分钟超时

class TaskMonitor {
  constructor() {
    this.interval = null;
    this.taskStartTimes = new Map(); // projectId -> startTime
  }

  start() {
    // 立即执行一次检查
    this.check();
    
    this.interval = setInterval(async () => {
      await this.check();
    }, CHECK_INTERVAL);
    
    console.log('[TaskMonitor] AI兜底监测已启动 (每5分钟检查一次)');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // 记录任务开始时间
  recordTaskStart(projectId) {
    this.taskStartTimes.set(projectId, Date.now());
    console.log('[TaskMonitor] 记录任务开始时间: ' + projectId);
  }

  // 清除任务开始时间
  clearTaskStart(projectId) {
    this.taskStartTimes.delete(projectId);
  }

  async check() {
    const taskQueue = getTaskQueue();
    const agentExecutor = getAgentExecutor();
    const config = getConfig();
    
    console.log('[TaskMonitor] ====== 开始AI兜底监测检查 [' + new Date().toISOString() + '] ======');
    
    // 检查每个活跃项目
    for (const project of config.monitored_projects) {
      if (!project.active) continue;
      
      const projectId = project.id;
      const executing = taskQueue.getExecutingTask(projectId);
      
      if (!executing) {
        // 没有执行中的任务，清理时间记录
        this.clearTaskStart(projectId);
        continue;
      }
      
      console.log('[TaskMonitor] 检查项目 ' + projectId + ': 任务 ' + executing.id + ' (' + executing.feature_name + ')');
      
      // 1. 检查是否有kimi进程在运行
      const hasKimiProcess = await this.checkKimiProcess(projectId);
      
      // 2. 检查任务是否超时
      const isTimeout = this.checkTimeout(projectId);
      
      // 3. 检查进程状态
      const processInfo = agentExecutor.processes[projectId];
      const processExists = processInfo && !processInfo.killed;
      
      console.log('[TaskMonitor] ' + projectId + ' 状态: kimi进程=' + hasKimiProcess + ', 进程对象=' + processExists + ', 超时=' + isTimeout);
      
      // 情况1: kimi进程不存在，但任务状态还是执行中 -> 任务可能已完成但未更新状态
      if (!hasKimiProcess && !processExists) {
        console.log('[TaskMonitor] ⚠️ ' + projectId + ': 检测到kimi进程已结束但任务状态仍为执行中，尝试检测输出...');
        await this.handleProcessEndedButTaskRunning(projectId, executing, agentExecutor);
        continue;
      }
      
      // 情况2: 任务超时
      if (isTimeout) {
        console.log('[TaskMonitor] ⚠️ ' + projectId + ': 任务执行超过25分钟，强制终止');
        await this.handleTimeout(projectId, executing, agentExecutor, taskQueue);
        continue;
      }
      
      // 情况3: 进程正常，记录检查通过
      if (hasKimiProcess) {
        console.log('[TaskMonitor] ✓ ' + projectId + ': 任务执行正常');
      }
    }
    
    console.log('[TaskMonitor] ====== AI兜底监测检查完成 ======');
  }

  // 检查是否有kimi进程在运行
  async checkKimiProcess(projectId) {
    try {
      // 检查是否有kimi进程
      const { stdout } = await execAsync('pgrep -f "kimi.*-p.*prompt-TASK" || echo "none"');
      const hasKimi = stdout.trim() !== 'none' && stdout.trim() !== '';
      
      if (hasKimi) {
        // 进一步检查是否是当前项目的任务
        const executing = getTaskQueue().getExecutingTask(projectId);
        if (executing) {
          const { stdout: detailStdout } = await execAsync('ps aux | grep -i "kimi.*' + executing.id + '" | grep -v grep || echo "none"');
          return detailStdout.trim() !== 'none' && detailStdout.trim() !== '';
        }
      }
      
      return hasKimi;
    } catch (err) {
      return false;
    }
  }

  // 检查任务是否超时
  checkTimeout(projectId) {
    const startTime = this.taskStartTimes.get(projectId);
    if (!startTime) {
      // 如果没有记录开始时间，使用executing中的started_at
      const executing = getTaskQueue().getExecutingTask(projectId);
      if (executing && executing.started_at) {
        const start = new Date(executing.started_at).getTime();
        return (Date.now() - start) > TASK_TIMEOUT;
      }
      return false;
    }
    return (Date.now() - startTime) > TASK_TIMEOUT;
  }

  // 处理进程已结束但任务状态仍为执行中的情况
  async handleProcessEndedButTaskRunning(projectId, executing, agentExecutor) {
    const taskQueue = getTaskQueue();
    
    // 获取终端输出，检查是否包含完成标记
    const terminalBuffer = require('../websocket/terminal-buffer');
    const session = terminalBuffer.getSession(projectId);
    const buffer = session ? session.buffer || '' : '';
    
    // 检测完成标记
    const successPatterns = [
      /修改完成|修改已成功|已成功修改/i,
      /任务已完成|任务完成|开发完成/i,
      /已完成.*移除|已成功.*删除/i,
      /总结.*修改|修改总结/i,
      /功能已实现|已实现.*功能/i,
      /代码已提交|已提交.*代码/i,
      /To resume this session/i
    ];
    
    const taskCompletedDetected = successPatterns.some(pattern => pattern.test(buffer));
    
    if (taskCompletedDetected) {
      console.log('[TaskMonitor] ✓ ' + projectId + ': 检测到任务已完成标记，自动更新状态为完成');
      
      // 更新任务状态为完成
      await taskQueue.completeTask(projectId, {
        message: 'AI兜底监测：检测到任务已完成（进程已结束且发现完成标记）',
        files_changed: [],
        completed_by_monitor: true
      });
      
      // 清理执行器状态
      agentExecutor.executingProjects.delete(projectId);
      delete agentExecutor.processes[projectId];
      this.clearTaskStart(projectId);
      
    } else {
      console.log('[TaskMonitor] ⚠️ ' + projectId + ': 进程已结束但未检测到完成标记，标记为失败');
      
      // 检查重试次数
      if (executing.error_count >= 2) {
        // 已经重试过多次，标记为失败
        await taskQueue.reportError(projectId, 'AI兜底监测：进程异常结束，未检测到完成标记', false);
      } else {
        // 重新入队重试
        await taskQueue.requeueForRetry(projectId);
        console.log('[TaskMonitor] ' + projectId + ': 任务已重新入队等待重试');
      }
      
      // 清理执行器状态
      agentExecutor.executingProjects.delete(projectId);
      delete agentExecutor.processes[projectId];
      this.clearTaskStart(projectId);
    }
  }

  // 处理任务超时
  async handleTimeout(projectId, executing, agentExecutor, taskQueue) {
    console.log('[TaskMonitor] ' + projectId + ': 强制终止超时任务');
    
    // 停止进程
    agentExecutor.stop(projectId);
    
    // 标记为失败（不重试，避免无限循环）
    await taskQueue.reportError(projectId, 'AI兜底监测：任务执行超时（超过25分钟）', false);
    
    // 清理状态
    agentExecutor.executingProjects.delete(projectId);
    delete agentExecutor.processes[projectId];
    this.clearTaskStart(projectId);
    
    console.log('[TaskMonitor] ' + projectId + ': 超时任务已处理');
  }
}

const taskMonitor = new TaskMonitor();

module.exports = {
  taskMonitor,
  getTaskMonitor: () => taskMonitor
};
