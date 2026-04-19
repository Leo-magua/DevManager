/**
 * 任务监控器 - AI兜底监测
 * 
 * 功能：
 * 1. 每5分钟检查一次执行中的任务
 * 2. 检测当前任务对应的 Agent 进程是否在运行
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
    this.lastActivityTime = new Map(); // projectId -> 最后一次任务活动时间（用于检测队列卡死）
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
    this.lastActivityTime.set(projectId, Date.now()); // 更新最后活动时间
    console.log('[TaskMonitor] 记录任务开始时间: ' + projectId);
  }

  // 清除任务开始时间
  clearTaskStart(projectId) {
    this.taskStartTimes.delete(projectId);
    this.lastActivityTime.set(projectId, Date.now()); // 任务结束也算活动
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
        
        // 兜底：检查是否有 Queued 任务卡死（队列推进链断裂）
        try {
          const status = await taskQueue.getStatus(projectId);
          if (status.queued_count > 0 && !agentExecutor.executingProjects.has(projectId)) {
            const lastActivity = this.lastActivityTime.get(projectId) || 0;
            const idleMinutes = Math.round((Date.now() - lastActivity) / 60000);
            if (lastActivity === 0 || (Date.now() - lastActivity) > 10 * 60 * 1000) {
              console.warn(`[TaskMonitor] ⚠️ ${projectId} 检测到队列卡死：${status.queued_count} 个任务已等待 ${idleMinutes} 分钟，触发兜底推进`);
              agentExecutor.tryExecute(projectId);
              this.lastActivityTime.set(projectId, Date.now()); // 更新，避免重复触发
            }
          }
        } catch (e) {
          console.error('[TaskMonitor] 检查 Queued 卡死时出错:', e.message);
        }
        
        continue;
      }
      
      console.log('[TaskMonitor] 检查项目 ' + projectId + ': 任务 ' + executing.id + ' (' + executing.feature_name + ')');
      
      // 1. 检查当前任务对应的 Agent 进程是否在运行
      const hasAgentProcess = await this.checkAgentProcess(projectId, executing);
      
      // 2. 检查任务是否超时
      const isTimeout = this.checkTimeout(projectId);
      
      // 3. 检查进程状态
      const processInfo = agentExecutor.processes[projectId];
      const processExists = processInfo && !processInfo.killed;
      
      console.log('[TaskMonitor] ' + projectId + ' 状态: agent进程=' + hasAgentProcess + ', 进程对象=' + processExists + ', 超时=' + isTimeout);
      
      // 情况1: kimi进程不存在，但任务状态还是执行中 -> 任务可能已完成但未更新状态
      if (!hasAgentProcess && !processExists) {
        console.log('[TaskMonitor] ⚠️ ' + projectId + ': 检测到 Agent 进程已结束但任务状态仍为执行中，尝试检测输出...');
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
      if (hasAgentProcess) {
        console.log('[TaskMonitor] ✓ ' + projectId + ': 任务执行正常');
      }
    }
    
    console.log('[TaskMonitor] ====== AI兜底监测检查完成 ======');
  }

  // 检查当前任务对应的 Agent 进程是否在运行
  async checkAgentProcess(projectId, executingTask = null) {
    try {
      const executing = executingTask || getTaskQueue().getExecutingTask(projectId);
      const toolType = executing?.tool_type || executing?.toolType || 'kimi';
      const taskId = executing?.id || '';

      if (toolType === 'codex') {
        const { stdout } = await execAsync(`ps aux | grep -i "codex" | grep -F "${taskId}" | grep -v grep || echo "none"`);
        return stdout.trim() !== 'none' && stdout.trim() !== '';
      }

      if (toolType === 'cursor') {
        const { stdout } = await execAsync(`ps aux | grep -i "cursor-run" | grep -F "${taskId}" | grep -v grep || echo "none"`);
        return stdout.trim() !== 'none' && stdout.trim() !== '';
      }

      const { stdout } = await execAsync(`ps aux | grep -i "kimi" | grep -F "${taskId}" | grep -v grep || echo "none"`);
      return stdout.trim() !== 'none' && stdout.trim() !== '';
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
      
      // 触发推进下一个任务（completeTask 的回调只做状态清除，推进由此处负责）
      if (!agentExecutor.stoppedProjects.has(projectId)) {
        console.log('[TaskMonitor] ' + projectId + ': 兜底完成，2秒后推进队列');
        setTimeout(() => agentExecutor.tryExecute(projectId), 2000);
      }
      
    } else {
      console.log('[TaskMonitor] ⚠️ ' + projectId + ': 进程已结束但未检测到完成标记，标记为失败');
      
      let needsRetryDelay = false;
      // 检查重试次数
      if (executing.error_count >= 2) {
        // 已经重试过多次，标记为失败（变 Pending）
        await taskQueue.reportError(projectId, 'AI兜底监测：进程异常结束，未检测到完成标记', false);
      } else {
        // 重新入队重试
        await taskQueue.requeueForRetry(projectId);
        needsRetryDelay = true;
        console.log('[TaskMonitor] ' + projectId + ': 任务已重新入队等待重试');
      }
      
      // 清理执行器状态
      agentExecutor.executingProjects.delete(projectId);
      delete agentExecutor.processes[projectId];
      this.clearTaskStart(projectId);
      
      // 无论哪种路径都需要触发推进，否则其他 Queued 任务会永久卡住
      if (!agentExecutor.stoppedProjects.has(projectId)) {
        if (needsRetryDelay) {
          // 重新入队的失败任务，30秒冷却后重试
          console.log('[TaskMonitor] ' + projectId + ': 兜底重入队，30秒后尝试推进队列');
          setTimeout(() => agentExecutor.tryExecute(null), 30 * 1000);
        } else {
          // 已标记为 Pending，推进其他 Queued 任务
          console.log('[TaskMonitor] ' + projectId + ': 兜底失败处理完毕，2秒后推进队列');
          setTimeout(() => agentExecutor.tryExecute(null), 2000);
        }
      }
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
