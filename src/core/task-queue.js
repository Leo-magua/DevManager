/**
 * 任务队列系统 (从各项目的 dev_state.json 读取)
 * 
 * 设计原则：
 * - 不再维护独立的 task-queue.json
 * - 以各项目路径下的 dev_state.json 为唯一数据源
 * - 只在内存中维护当前执行中的任务状态
 */
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');
const { broadcast } = require('../websocket/broadcast');

/** 开发队列中等待（顺序 = feature_list 中相对顺序） */
const STATUS_QUEUED = 'Queued';

class TaskQueue {
  constructor() {
    // 只在内存中维护当前执行状态，不持久化
    this.executingTasks = new Map(); // projectId -> taskInfo
    this.globalPaused = false;
  }

  /**
   * 从项目的 dev_state.json 读取 feature_list
   */
  async getProjectFeatures(projectId) {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) return null;

    try {
      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);
      return {
        features: devState.feature_list || [],
        context: devState.current_context || {},
        project
      };
    } catch (err) {
      return { features: [], context: {}, project };
    }
  }

  /**
   * 获取项目的待处理任务（从 dev_state.json 推导）
   */
  async getPendingTasks(projectId) {
    const projectData = await this.getProjectFeatures(projectId);
    if (!projectData) return [];

    const executingFeatureId = this.executingTasks.get(projectId)?.feature_id;
    
    // 待处理列：仅 Pending（不含 Queued）
    return projectData.features
      .filter(f => f.status === 'Pending' || !f.status)
      .filter(f => f.id !== executingFeatureId)
      .map(f => this._toTaskInfo(projectId, f));
  }

  _toTaskInfo(projectId, f) {
    return {
      id: `TASK-${f.id}`,
      project_id: projectId,
      feature_id: f.id,
      feature_name: f.name,
      feature_desc: f.description || '',
      category: f.category || 'Feature',
      created_at: f.created_at || new Date().toISOString()
    };
  }

  /**
   * 按 feature_list 顺序返回开发队列中的等待项（不含正在执行的那条）
   */
  async getQueuedFeaturesInOrder(projectId) {
    const projectData = await this.getProjectFeatures(projectId);
    if (!projectData) return [];
    return (projectData.features || []).filter(f => f.status === STATUS_QUEUED);
  }

  async saveDevStateFeatureList(project, featureList) {
    const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
    const raw = await fs.readFile(devStatePath, 'utf-8');
    const devState = JSON.parse(raw);
    devState.feature_list = featureList;
    await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
  }

  /**
   * 从待处理进入开发队列：标为 Queued，并排到「当前开发块」末尾（In_Progress / Queued 之后）
   */
  async enqueueFeature(projectId, featureId) {
    const projectData = await this.getProjectFeatures(projectId);
    if (!projectData?.project) return { error: '项目不存在' };
    const project = projectData.project;
    const features = [...(projectData.features || [])];
    const idx = features.findIndex(f => f.id === featureId);
    if (idx === -1) return { error: '功能项不存在' };
    const f = features[idx];
    const st = f.status || 'Pending';
    if (st === 'Completed') return { error: '已完成项不能入队' };
    if (st === STATUS_QUEUED || st === 'In_Progress') return { success: true, already: true };

    const [item] = features.splice(idx, 1);
    item.status = STATUS_QUEUED;
    item.updated_at = new Date().toISOString();

    let insertAt = features.length;
    for (let i = features.length - 1; i >= 0; i--) {
      if (features[i].status === STATUS_QUEUED || features[i].status === 'In_Progress') {
        insertAt = i + 1;
        break;
      }
    }
    features.splice(insertAt, 0, item);

    await this.saveDevStateFeatureList(project, features);
    broadcast('feature_updated', { project_id: projectId, feature_id: featureId });
    return { success: true };
  }

  /**
   * 若无执行中且未暂停，认领队列头（第一个 Queued）并返回 task（由调用方 executeTask）
   */
  async maybeStartNextFromQueue(projectId, agentInfo = { agent_id: 'queue', agent_name: 'Dev Queue' }) {
    if (this.executingTasks.has(projectId)) return { started: false };
    if (this.globalPaused) return { started: false };
    const claimResult = await this.claimTask(projectId, agentInfo);
    if (!claimResult.success) return { started: false, ...claimResult };
    return { started: true, task: claimResult.task };
  }

  /**
   * 获取项目状态
   */
  async getStatus(projectId = null) {
    if (projectId) {
      const projectData = await this.getProjectFeatures(projectId);
      const features = projectData?.features || [];
      const executing = this.executingTasks.get(projectId) || null;
      const pendingCount = features.filter(f => (f.status === 'Pending' || !f.status) && f.id !== executing?.feature_id).length;
      const queuedCount = features.filter(f => f.status === STATUS_QUEUED).length;

      return {
        paused: this.globalPaused,
        pending_count: pendingCount,
        queued_count: queuedCount,
        in_progress: executing,
        executing: executing
      };
    }

    // 全局状态
    let pendingTotal = 0;
    let queuedTotal = 0;
    const config = getConfig();
    
    for (const project of config.monitored_projects) {
      if (!project.active) continue;
      const s = await this.getStatus(project.id);
      pendingTotal += s.pending_count;
      queuedTotal += s.queued_count;
    }

    return {
      paused: this.globalPaused,
      pending_count: pendingTotal,
      queued_count: queuedTotal,
      executing_count: this.executingTasks.size,
      executing_tasks: Array.from(this.executingTasks.entries()).map(([pid, task]) => ({
        project_id: pid,
        ...task
      }))
    };
  }

  /**
   * 认领任务 - 更新 dev_state.json 中的状态
   * @param {object} options.featureId 若指定则认领该功能（须为待处理；或由看板先标为开发中后再认领同一 id）
   */
  async claimTask(projectId, agentInfo = {}, options = {}) {
    const projectData = await this.getProjectFeatures(projectId);
    if (!projectData) {
      return { error: '项目不存在' };
    }

    // 检查是否已有任务在执行
    if (this.executingTasks.has(projectId)) {
      return { error: '该项目已有任务在执行中', current: this.executingTasks.get(projectId) };
    }

    const explicitFeatureId = options.featureId;
    const features = projectData.features || [];
    let taskInfo;

    if (explicitFeatureId) {
      const feature = features.find(f => f.id === explicitFeatureId);
      if (!feature) {
        return { error: '功能项不存在' };
      }
      const st = feature.status || 'Pending';
      if (st === 'Completed') {
        return { error: '已完成的任务无法开始开发' };
      }
      if (st !== 'Pending' && st !== STATUS_QUEUED && st !== 'In_Progress') {
        return { error: '无法认领该状态的任务' };
      }
      taskInfo = this._toTaskInfo(projectId, feature);
    } else {
      const projectData = await this.getProjectFeatures(projectId);
      const features = projectData?.features || [];
      const firstQueued = features.find(f => f.status === STATUS_QUEUED);
      if (!firstQueued) {
        return { error: '开发队列为空' };
      }
      taskInfo = this._toTaskInfo(projectId, firstQueued);
    }
    
    // 更新 dev_state.json
    await this.updateFeatureStatus(projectId, taskInfo.feature_id, 'In_Progress', {
      agent_task_id: taskInfo.id,
      task_name: taskInfo.feature_name,
      start_time: new Date().toISOString(),
      agent_info: agentInfo
    });

    // 记录到内存
    this.executingTasks.set(projectId, {
      ...taskInfo,
      started_at: new Date().toISOString(),
      agent_info: agentInfo,
      error_count: 0,
      last_error: null
    });

    broadcast('task_started', { project_id: projectId, task: taskInfo });
    
    return { success: true, task: taskInfo };
  }

  /**
   * 完成任务
   */
  async completeTask(projectId, result = {}) {
    const executing = this.executingTasks.get(projectId);
    if (!executing) {
      return { error: '没有正在执行的任务' };
    }

    // 更新 dev_state.json
    await this.updateFeatureStatus(projectId, executing.feature_id, 'Completed', {
      agent_task_id: null,
      task_name: '等待指令',
      in_progress_feature_id: null,
      start_time: null,
      last_error: null,
      trial_count: 0
    });

    // 添加到 changelog
    await this.addChangelog(projectId, 'system', `任务完成: ${executing.feature_name}`, result.message || '');

    // 清理内存状态
    this.executingTasks.delete(projectId);

    broadcast('task_completed', { project_id: projectId, task: executing, result });
    
    return { success: true, task: executing };
  }

  /**
   * 报告错误
   */
  async reportError(projectId, error, retry = true) {
    const executing = this.executingTasks.get(projectId);
    if (!executing) {
      return { error: '没有正在执行的任务' };
    }

    executing.error_count = (executing.error_count || 0) + 1;
    executing.last_error = error;

    if (!retry || executing.error_count >= 3) {
      // 不再重试，重置为 Pending
      await this.updateFeatureStatus(projectId, executing.feature_id, 'Pending', {
        agent_task_id: null,
        task_name: '等待指令',
        in_progress_feature_id: null,
        start_time: null,
        last_error: error,
        trial_count: executing.error_count
      });

      await this.addChangelog(projectId, 'error', `任务失败: ${executing.feature_name}`, error);

      this.executingTasks.delete(projectId);
      
      broadcast('task_failed', { project_id: projectId, task: executing, error });
      
      return { success: true, status: 'failed', task: executing };
    } else {
      // 继续重试
      await this.addChangelog(projectId, 'error', `任务出错(第${executing.error_count}次): ${executing.feature_name}`, error);
      
      broadcast('task_error', { project_id: projectId, task: executing, error, retry: true });
      
      return { success: true, status: 'retry', task: executing };
    }
  }

  /**
   * 重新入队等待重试（保持 Queued 状态，清理执行内存）
   */
  async requeueForRetry(projectId) {
    const executing = this.executingTasks.get(projectId);
    if (!executing) return;

    await this.updateFeatureStatus(projectId, executing.feature_id, STATUS_QUEUED, {
      agent_task_id: null,
      task_name: '等待重试 (第' + executing.error_count + '次)',
      start_time: null
    });

    this.executingTasks.delete(projectId);
    broadcast('task_queued_for_retry', { project_id: projectId, task: executing });
  }

  /**
   * 暂停当前任务（保留在 Queued 队列，停止执行）
   */
  async pauseTask(projectId) {
    const executing = this.executingTasks.get(projectId);
    if (!executing) {
      return { error: '没有正在执行的任务' };
    }

    await this.updateFeatureStatus(projectId, executing.feature_id, STATUS_QUEUED, {
      agent_task_id: null,
      task_name: '已暂停',
      start_time: null
    });

    await this.addChangelog(projectId, 'system', '任务已暂停: ' + executing.feature_name, '用户手动暂停，保留在队列中');

    this.executingTasks.delete(projectId);
    broadcast('task_paused', { project_id: projectId, task: executing });
    return { success: true, task: executing };
  }

    /**
   * 停止任务
   */
  async stopTask(projectId, reason = '用户手动停止') {
    const executing = this.executingTasks.get(projectId);
    if (!executing) {
      return { error: '没有正在执行的任务' };
    }

    // 更新 dev_state.json - 重置为 Pending
    await this.updateFeatureStatus(projectId, executing.feature_id, 'Pending', {
      agent_task_id: null,
      task_name: '等待指令',
      in_progress_feature_id: null,
      start_time: null,
      last_error: reason,
      trial_count: 0
    });

    await this.addChangelog(projectId, 'system', `任务停止: ${executing.feature_name}`, reason);

    this.executingTasks.delete(projectId);
    
    broadcast('task_stopped', { project_id: projectId, task: executing, reason });
    
    return { success: true, task: executing };
  }

  /**
   * 更新 dev_state.json 中的功能状态
   */
  async updateFeatureStatus(projectId, featureId, status, contextUpdate = {}) {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) return;

    const devStatePath = path.join(project.path, 'dev_state.json');
    
    try {
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      // 更新 feature 状态
      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (feature) {
        feature.status = status;
        feature.updated_at = new Date().toISOString();
      }

      // 更新 current_context
      devState.current_context = {
        ...(devState.current_context || {}),
        ...contextUpdate
      };

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
    } catch (err) {
      console.error(`[TaskQueue] 更新 dev_state.json 失败:`, err.message);
    }
  }

  /**
   * 添加 changelog
   */
  async addChangelog(projectId, type, message, details = '') {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) return;

    const devStatePath = path.join(project.path, 'dev_state.json');
    
    try {
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        id: `LOG${Date.now()}`,
        timestamp: new Date().toISOString(),
        type,
        message,
        details: details.substring(0, 200)
      });

      // 只保留最近 50 条
      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
    } catch (err) {
      console.error(`[TaskQueue] 添加 changelog 失败:`, err.message);
    }
  }

  /**
   * 获取执行中任务信息（用于 AgentExecutor）
   */
  getExecutingTask(projectId) {
    return this.executingTasks.get(projectId) || null;
  }

  /**
   * 暂停/恢复
   */
  setPaused(paused) {
    this.globalPaused = paused;
    broadcast('pause_changed', { paused });
    return { paused: this.globalPaused };
  }

  isPaused() {
    return this.globalPaused;
  }
}

const taskQueue = new TaskQueue();

module.exports = {
  taskQueue,
  getTaskQueue: () => taskQueue
};
