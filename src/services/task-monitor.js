/**
 * 任务监控器
 * 
 * 新架构：从各项目的 dev_state.json 读取状态
 */
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getConfig } = require('../config');

class TaskMonitor {
  constructor() {
    this.interval = null;
  }

  start() {
    this.interval = setInterval(async () => {
      await this.check();
    }, 30000);
    console.log('[TaskMonitor] 监控器已启动 (30秒间隔)');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async check() {
    const taskQueue = getTaskQueue();
    const agentExecutor = getAgentExecutor();
    const config = getConfig();
    
    // 自动执行任务功能已禁用 - 必须用户手动点击开始
    // 如需启用，请设置环境变量 ENABLE_AUTO_TASK_EXECUTION=true
    const autoExecutionEnabled = process.env.ENABLE_AUTO_TASK_EXECUTION === 'true';
    
    if (!autoExecutionEnabled) {
      return; // 完全禁用自动执行
    }
    
    // 检查每个项目是否有待处理任务需要自动执行
    for (const project of config.monitored_projects) {
      if (!project.active) continue;
      
      const projectId = project.id;
      
      // 检查是否已有任务在执行
      const executing = taskQueue.getExecutingTask(projectId);
      if (executing || agentExecutor.executingProjects.has(projectId)) {
        continue;
      }
      
      // 跳过被手动停止的项目
      if (agentExecutor.stoppedProjects && agentExecutor.stoppedProjects.has(projectId)) {
        continue;
      }
      
      // 获取待处理任务
      const pending = await taskQueue.getPendingTasks(projectId);
      if (pending.length === 0) continue;
      
      // 获取第一个待处理任务
      const task = pending[0];
      
      // 检查任务是否最近创建（10分钟内）
      const now = new Date();
      const taskCreated = new Date(task.created_at);
      const minutesSinceCreated = (now - taskCreated) / 1000 / 60;
      
      if (minutesSinceCreated <= 10) {
        console.log(`[TaskMonitor] 检测到 ${projectId} 有新待处理任务 (${minutesSinceCreated.toFixed(1)}分钟前)，触发执行`);
        agentExecutor.tryExecute(projectId);
      }
    }
  }
}

const taskMonitor = new TaskMonitor();

module.exports = {
  taskMonitor,
  getTaskMonitor: () => taskMonitor
};
