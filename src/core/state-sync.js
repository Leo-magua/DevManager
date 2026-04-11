/**
 * 状态同步器
 * 
 * 新架构：以各项目的 dev_state.json 为唯一数据源
 * 只在内存中维护执行状态，重启后从 dev_state.json 恢复
 */
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const { getConfig } = require('../config');
const { getAgentExecutor } = require('./agent-executor');

class StateSync {
  async syncOnStartup() {
    console.log('[StateSync] 启动状态同步...');
    
    const config = getConfig();
    const agentExecutor = getAgentExecutor();
    const syncedProjects = new Set();
    
    // 检查每个项目的 dev_state，清理不一致的状态
    for (const project of config.monitored_projects) {
      if (!project.active) continue;
      
      try {
        const needsFix = await this.syncProjectState(project.id);
        if (needsFix) {
          syncedProjects.add(project.id);
        }
      } catch (err) {
        console.error(`[StateSync] 同步 ${project.id} 失败:`, err.message);
      }
    }
    
    console.log(`[StateSync] 完成，修复了 ${syncedProjects.size} 个项目`);
  }

  async syncProjectState(projectId) {
    const config = getConfig();
    
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) return false;
    
    const devStatePath = path.join(project.path, 'dev_state.json');
    
    let devState;
    try {
      const data = await fs.readFile(devStatePath, 'utf-8');
      devState = JSON.parse(data);
    } catch (err) {
      console.log(`[StateSync] ${projectId} dev_state.json 不存在或无法读取`);
      return false;
    }
    
    let needsSave = false;
    let hasInProgress = false;
    
    // 重启后无内存执行态：In_Progress 改为 Queued，保留在开发队列中等待再次调度
    for (const feature of devState.feature_list || []) {
      if (feature.status === 'In_Progress') {
        console.log(`[StateSync] ${projectId}/${feature.id} In_Progress -> Queued (服务器重启)`);
        feature.status = 'Queued';
        needsSave = true;
      }
    }
    
    // 检查 current_context
    const ctx = devState.current_context || {};
    if (ctx.agent_task_id || ctx.in_progress_feature_id) {
      console.log(`[StateSync] ${projectId} 清理 current_context`);
      devState.current_context = {
        agent_task_id: null,
        task_name: '等待指令',
        in_progress_feature_id: null,
        start_time: null,
        last_error: null,
        trial_count: 0
      };
      needsSave = true;
    }
    
    if (needsSave) {
      devState.updated_at = new Date().toISOString();
      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      console.log(`[StateSync] ${projectId} 状态已修复`);
      return true;
    } else {
      console.log(`[StateSync] ${projectId} 状态一致`);
      return false;
    }
  }

  /**
   * 检查指定项目的 Agent 进程是否在运行
   */
  isAgentProcessRunning(projectId) {
    try {
      const agentExecutor = getAgentExecutor();
      
      // 检查 AgentExecutor 中的进程记录
      if (agentExecutor.processes[projectId]) {
        return true;
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
