/**
 * 状态同步器
 */
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const { getConfig } = require('../config');
const { getTaskQueue } = require('./task-queue');
const { getAgentExecutor } = require('./agent-executor');

class StateSync {
  async syncOnStartup() {
    console.log('[StateSync] 启动状态同步...');
    
    const config = getConfig();
    const taskQueue = getTaskQueue();
    const agentExecutor = getAgentExecutor();
    const status = taskQueue.getStatus();
    const syncedProjects = new Set();
    
    // 1. 检查队列中的 in_progress 任务，验证是否有对应的 Agent 进程在运行
    for (const [projectId, task] of Object.entries(status.queue.in_progress)) {
      // 检查该项目的 Agent 进程是否还在运行
      const isAgentRunning = this.isAgentProcessRunning(projectId);
      
      if (!isAgentRunning) {
        // Agent 进程已不存在，任务已中断，重置为 Pending
        console.log(`[StateSync] ${projectId} 的 Agent 进程已不存在，重置任务: ${task.feature_name}`);
        await taskQueue.resetProjectTask(projectId, '服务器重启，Agent 进程不存在');
        syncedProjects.add(projectId);
      } else {
        // Agent 进程还在运行，更新状态
        console.log(`[StateSync] ${projectId} 的 Agent 进程仍在运行，保持 In_Progress 状态`);
        await taskQueue.updateProjectFeatureStatus(projectId, task.feature_id, 'In_Progress');
        syncedProjects.add(projectId);
      }
    }
    
    // 2. 检查每个项目的 dev_state
    for (const project of config.monitored_projects) {
      if (!project.active) continue;
      
      try {
        await this.syncProjectState(project.id);
        syncedProjects.add(project.id);
      } catch (err) {
        console.error(`[StateSync] 同步 ${project.id} 失败:`, err.message);
      }
    }
    
    console.log(`[StateSync] 完成，同步了 ${syncedProjects.size} 个项目`);
  }

  async syncProjectState(projectId) {
    const config = getConfig();
    const taskQueue = getTaskQueue();
    
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) return;
    
    const devStatePath = path.join(project.path, 'dev_state.json');
    
    let devState;
    try {
      const data = await fs.readFile(devStatePath, 'utf-8');
      devState = JSON.parse(data);
    } catch (err) {
      console.log(`[StateSync] ${projectId} dev_state.json 不存在或无法读取`);
      return;
    }
    
    const queueStatus = taskQueue.getStatus(projectId);
    let needsSave = false;
    
    // 检查 dev_state 中标记为 In_Progress 的功能
    for (const feature of devState.feature_list || []) {
      if (feature.status === 'In_Progress') {
        const inProgressTask = queueStatus.in_progress;
        const hasQueueTask = inProgressTask && inProgressTask.feature_id === feature.id;
        
        if (!hasQueueTask) {
          console.log(`[StateSync] ${projectId}/${feature.id} 状态不一致: dev_state=In_Progress, queue=无任务 -> 重置为 Pending`);
          feature.status = 'Pending';
          needsSave = true;
        }
      }
    }
    
    // 检查 current_context 是否需要清理
    const ctx = devState.current_context || {};
    const hasInProgressTask = queueStatus.in_progress !== null;
    
    if (!hasInProgressTask && ctx.agent_task_id) {
      console.log(`[StateSync] ${projectId} 清理过期的 current_context`);
      devState.current_context = {
        agent_task_id: null,
        task_name: '等待指令',
        start_time: null,
        last_error: null,
        trial_count: 0
      };
      needsSave = true;
    }
    
    if (needsSave) {
      devState.updated_at = new Date().toISOString();
      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      console.log(`[StateSync] ${projectId} 状态已修复并保存`);
    } else {
      console.log(`[StateSync] ${projectId} 状态一致，无需修复`);
    }
  }

  /**
   * 检查指定项目的 Agent 进程是否在运行
   */
  isAgentProcessRunning(projectId) {
    try {
      const agentExecutor = getAgentExecutor();
      
      // 方法1: 检查 AgentExecutor 中的进程记录
      if (agentExecutor.processes[projectId]) {
        return true;
      }
      
      // 方法2: 检查是否有 kimi 进程在项目目录下运行
      try {
        const config = getConfig();
        const project = config.monitored_projects.find(p => p.id === projectId);
        if (project) {
          // 查找在项目目录下运行的 kimi 进程
          const cmd = `ps aux | grep -E "kimi.*${project.path}|kimi.*${projectId}" | grep -v grep`;
          const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
          if (result && result.trim()) {
            return true;
          }
        }
      } catch (e) {
        // 命令执行失败，说明没有匹配的进程
      }
      
      return false;
    } catch (err) {
      console.error(`[StateSync] 检查 Agent 进程失败: ${err.message}`);
      return false;
    }
  }
}

const stateSync = new StateSync();

module.exports = {
  stateSync,
  getStateSync: () => stateSync
};
