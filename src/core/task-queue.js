/**
 * 任务队列系统 (支持多项目)
 */
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');
const { broadcast } = require('../websocket/broadcast');

const QUEUE_PATH = path.join(__dirname, '../..', 'data', 'task-queue.json');

class TaskQueue {
  constructor() {
    this.queue = {
      pending: [],
      in_progress: {},
      completed: [],
      version: '2.1'
    };
    this.globalPaused = false; // 全局暂停状态
  }

  async ensureQueueFile() {
    try {
      await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
      await fs.access(QUEUE_PATH);
      const data = await fs.readFile(QUEUE_PATH, 'utf-8');
      const loaded = JSON.parse(data);
      
      // 迁移旧版本数据
      if (loaded.version === '2.0' && loaded.in_progress && !loaded.in_progress.project_id) {
        const oldTask = loaded.in_progress;
        this.queue = {
          pending: loaded.pending || [],
          in_progress: oldTask ? { [oldTask.project_id]: oldTask } : {},
          completed: loaded.completed || [],
          version: '2.1'
        };
      } else {
        this.queue = loaded;
      }
    } catch (err) {
      console.error('[TaskQueue] 队列文件解析失败:', err.message);
      try {
        const raw = await fs.readFile(QUEUE_PATH, 'utf-8');
        let repaired = null;
        for (let i = raw.length; i > 0; i--) {
          try {
            repaired = JSON.parse(raw.slice(0, i));
            break;
          } catch (_) {}
        }
        if (repaired && Array.isArray(repaired.pending) && repaired.in_progress && typeof repaired.in_progress === 'object') {
          const bak = `${QUEUE_PATH}.corrupt.${Date.now()}`;
          await fs.copyFile(QUEUE_PATH, bak);
          console.log(`[TaskQueue] 已备份损坏文件到 ${bak}，并尝试恢复`);
          if (repaired.version === '2.0' && repaired.in_progress && !repaired.in_progress.project_id) {
            const oldTask = repaired.in_progress;
            this.queue = {
              pending: repaired.pending || [],
              in_progress: oldTask ? { [oldTask.project_id]: oldTask } : {},
              completed: repaired.completed || [],
              version: '2.1'
            };
          } else {
            this.queue = repaired;
          }
          await this.save();
        } else {
          await this.save();
        }
      } catch (e2) {
        console.error('[TaskQueue] 恢复失败，使用空队列:', e2.message);
        await this.save();
      }
    }
  }

  async save() {
    await fs.writeFile(QUEUE_PATH, JSON.stringify(this.queue, null, 2));
  }

  getProjectInProgress(projectId) {
    return this.queue.in_progress[projectId] || null;
  }

  getInProgressCount() {
    return Object.keys(this.queue.in_progress).length;
  }

  async addTask(projectId, featureId, feature) {
    const task = {
      id: `TASK-${Date.now()}`,
      project_id: projectId,
      feature_id: featureId,
      feature_name: feature.name,
      feature_desc: feature.description || '',
      category: feature.category,
      status: 'pending',
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      agent_info: null,
      error_count: 0,
      last_error: null,
      logs: []
    };

    this.queue.pending.push(task);
    // 按创建时间排序（FIFO）
    this.queue.pending.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    await this.save();
    broadcast('task_added', task);
    
    // 如果未暂停，触发自动执行
    if (!this.globalPaused) {
      const { getAgentExecutor } = require('./agent-executor');
      const executor = getAgentExecutor();
      if (executor) {
        executor.tryExecute(projectId);
      }
    }
    
    return task;
  }

  async claimTask(projectId, agentInfo = {}) {
    if (this.queue.in_progress[projectId]) {
      return { error: '该项目已有任务在执行中', current: this.queue.in_progress[projectId] };
    }

    const taskIndex = this.queue.pending.findIndex(t => t.project_id === projectId);
    if (taskIndex === -1) {
      return { error: '该项目的任务队列为空' };
    }

    const task = this.queue.pending.splice(taskIndex, 1)[0];
    task.status = 'in_progress';
    task.started_at = new Date().toISOString();
    task.agent_info = {
      ...agentInfo,
      claimed_at: new Date().toISOString()
    };

    this.queue.in_progress[projectId] = task;
    await this.save();
    await this.updateProjectFeatureStatus(projectId, task.feature_id, 'In_Progress');
    
    broadcast('task_started', task);
    
    return { success: true, task };
  }

  async claimAnyTask(agentInfo = {}) {
    if (this.queue.pending.length === 0) {
      return { error: '全局队列为空' };
    }

    const taskIndex = this.queue.pending.findIndex(t => !this.queue.in_progress[t.project_id]);
    if (taskIndex === -1) {
      return { error: '所有项目都已有任务在执行中' };
    }

    const task = this.queue.pending.splice(taskIndex, 1)[0];
    const projectId = task.project_id;
    
    task.status = 'in_progress';
    task.started_at = new Date().toISOString();
    task.agent_info = {
      ...agentInfo,
      claimed_at: new Date().toISOString()
    };

    this.queue.in_progress[projectId] = task;
    await this.save();
    await this.updateProjectFeatureStatus(projectId, task.feature_id, 'In_Progress');
    
    broadcast('task_started', task);
    
    return { success: true, task };
  }

  async completeTask(projectId, result = {}) {
    if (!this.queue.in_progress[projectId]) {
      return { error: '该项目没有正在执行的任务' };
    }

    const task = this.queue.in_progress[projectId];
    task.status = 'completed';
    task.completed_at = new Date().toISOString();
    task.result = result;
    task.logs.push({
      time: new Date().toISOString(),
      action: 'completed',
      message: result.message || '任务完成'
    });

    this.queue.completed.unshift(task);
    if (this.queue.completed.length > 100) {
      this.queue.completed = this.queue.completed.slice(0, 100);
    }

    delete this.queue.in_progress[projectId];
    await this.save();
    await this.updateProjectFeatureStatus(projectId, task.feature_id, 'Completed');
    
    broadcast('task_completed', task);
    
    // 如果未暂停，触发下一个任务
    if (!this.globalPaused) {
      setTimeout(() => {
        const { getAgentExecutor } = require('./agent-executor');
        const executor = getAgentExecutor();
        if (executor) {
          executor.tryExecute(projectId);
        }
      }, 1000);
    }
    
    return { success: true, task };
  }

  async reportError(projectId, error, retry = false) {
    if (!this.queue.in_progress[projectId]) {
      return { error: '该项目没有正在执行的任务' };
    }

    const task = this.queue.in_progress[projectId];
    task.error_count++;
    task.last_error = error;
    task.logs.push({
      time: new Date().toISOString(),
      action: 'error',
      message: error,
      retry_count: task.error_count
    });

    if (!retry || task.error_count >= 3) {
      task.status = 'failed';
      this.queue.completed.unshift(task);
      delete this.queue.in_progress[projectId];
      await this.updateProjectFeatureStatus(projectId, task.feature_id, 'Pending');
      broadcast('task_failed', task);
      
      setTimeout(() => {
        const { getAgentExecutor } = require('./agent-executor');
        const executor = getAgentExecutor();
        if (executor) {
          executor.tryExecute(projectId);
        }
      }, 1000);
    }

    await this.save();
    return { success: true, task, retry_count: task.error_count };
  }

  async addLog(projectId, type, message, data = {}) {
    if (!this.queue.in_progress[projectId]) {
      return { error: '该项目没有正在执行的任务' };
    }

    const task = this.queue.in_progress[projectId];
    const logEntry = {
      time: new Date().toISOString(),
      action: 'log',
      type: type,
      message: message,
      ...data
    };

    task.logs.push(logEntry);
    if (task.logs.length > 100) {
      task.logs = task.logs.slice(-100);
    }

    await this.save();
    broadcast('task_log', { task_id: task.id, log: logEntry });
    
    return { success: true, log: logEntry };
  }

  getCurrentLogs(projectId) {
    const task = this.queue.in_progress[projectId];
    if (!task) {
      return { has_task: false, logs: [] };
    }
    
    return {
      has_task: true,
      task_id: task.id,
      task_name: task.feature_name,
      logs: task.logs || []
    };
  }

  async updateProjectFeatureStatus(projectId, featureId, status) {
    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        console.error(`[TaskQueue] 项目不存在: ${projectId}`);
        return;
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      
      let devState;
      try {
        const data = await fs.readFile(devStatePath, 'utf-8');
        devState = JSON.parse(data);
      } catch (err) {
        console.error(`[TaskQueue] 读取 dev_state.json 失败: ${err.message}`);
        return;
      }

      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (feature) {
        const oldStatus = feature.status;
        feature.status = status;
        console.log(`[TaskQueue] ${projectId}/${featureId}: ${oldStatus} -> ${status}`);
      } else {
        console.warn(`[TaskQueue] 功能项不在 dev_state 看板中: ${projectId}/${featureId}`);
      }

      devState.updated_at = new Date().toISOString();

      const inProgressTask = this.queue.in_progress[projectId];
      devState.current_context = {
        ...(devState.current_context || {}),
        agent_task_id: inProgressTask?.id || null,
        task_name: inProgressTask?.feature_name || '等待指令',
        trial_count: inProgressTask?.error_count ?? 0,
        last_error: inProgressTask?.last_error ?? null
      };

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
    } catch (err) {
      console.error('[TaskQueue] 更新项目状态失败:', err);
    }
  }

  getStatus(projectId = null) {
    const inProgressMap = this.queue.in_progress || {};
    
    if (projectId) {
      return {
        paused: this.globalPaused,
        pending_count: this.queue.pending.filter(t => t.project_id === projectId).length,
        in_progress: inProgressMap[projectId] || null,
        completed_count: this.queue.completed.filter(t => t.project_id === projectId).length,
        queue: {
          pending: this.queue.pending.filter(t => t.project_id === projectId),
          in_progress: inProgressMap[projectId] || null,
          completed: this.queue.completed.filter(t => t.project_id === projectId)
        }
      };
    }
    
    return {
      paused: this.globalPaused,
      pending_count: this.queue.pending.length,
      in_progress_count: Object.keys(inProgressMap).length,
      in_progress: inProgressMap,
      completed_count: this.queue.completed.length,
      queue: this.queue
    };
  }

  async checkStalledTasks() {
    const stalled = [];
    const now = new Date();
    const inProgressMap = this.queue.in_progress || {};
    
    for (const [projectId, task] of Object.entries(inProgressMap)) {
      const startedAt = new Date(task.started_at);
      const elapsedMinutes = (now - startedAt) / 1000 / 60;
      
      if (elapsedMinutes > 30) {
        console.log(`[TaskMonitor] 检测到卡死任务: ${projectId}/${task.feature_name} (${elapsedMinutes.toFixed(1)}分钟)`);
        stalled.push({ projectId, task });
      }
    }
    
    return stalled;
  }

  async resetProjectTask(projectId, reason) {
    if (!this.queue.in_progress[projectId]) return null;
    
    const task = this.queue.in_progress[projectId];
    task.status = 'pending';
    task.started_at = null;
    task.agent_info = null;
    task.logs.push({
      time: new Date().toISOString(),
      action: 'reset',
      message: `任务被重置: ${reason}`
    });
    
    this.queue.pending.unshift(task);
    delete this.queue.in_progress[projectId];
    await this.save();
    
    await this.updateProjectFeatureStatus(projectId, task.feature_id, 'Pending');
    broadcast('task_reset', { task, reason });
    
    console.log(`[TaskMonitor] ${projectId} 任务已重置: ${task.feature_name}`);
    return task;
  }

  // ========== 暂停控制 ==========

  isPaused() {
    return this.globalPaused;
  }

  async setPaused(paused) {
    this.globalPaused = paused;
    broadcast('pause_state_changed', { paused: this.globalPaused });
    console.log(`[TaskQueue] 全局暂停状态: ${paused ? '已暂停' : '已恢复'}`);
    return { paused: this.globalPaused };
  }

  async stopTask(projectId, reason = '用户手动停止') {
    const task = this.queue.in_progress[projectId];
    if (!task) {
      return { error: '该项目没有正在执行的任务' };
    }

    // 停止 Agent 执行
    const { getAgentExecutor } = require('./agent-executor');
    const executor = getAgentExecutor();
    if (executor) {
      executor.stop(projectId);
    }

    // 将任务移回 pending
    task.status = 'pending';
    task.started_at = null;
    task.agent_info = null;
    task.logs.push({
      time: new Date().toISOString(),
      action: 'stopped',
      message: `任务被停止: ${reason}`
    });

    this.queue.pending.unshift(task);
    delete this.queue.in_progress[projectId];
    await this.save();

    await this.updateProjectFeatureStatus(projectId, task.feature_id, 'Pending');
    broadcast('task_stopped', { task, reason });

    console.log(`[TaskQueue] ${projectId} 任务已停止: ${task.feature_name}`);
    return { success: true, task };
  }

  async stopAllTasks(reason = '用户手动停止所有任务') {
    const results = [];
    for (const projectId of Object.keys(this.queue.in_progress)) {
      results.push(await this.stopTask(projectId, reason));
    }
    return { stopped: results.length, results };
  }
}

const taskQueue = new TaskQueue();

module.exports = {
  taskQueue,
  getTaskQueue: () => taskQueue
};
