/**
 * 任务监控器
 */
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');

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
    
    // 检查卡死任务 - 重置后不自动执行，让用户决定是否继续
    const stalledTasks = await taskQueue.checkStalledTasks();
    for (const { projectId, task } of stalledTasks) {
      console.log(`[TaskMonitor] 回收卡死任务: ${projectId}/${task.feature_name}`);
      await taskQueue.resetProjectTask(projectId, '执行超时(30分钟)');
      // 不自动重新执行，给用户干预的机会
      console.log(`[TaskMonitor] ${projectId} 任务已重置，等待用户手动触发或新任务添加`);
    }
    
    // 检查是否有待处理任务的项目（只检查最近10分钟内更新的任务）
    const status = taskQueue.getStatus();
    const now = new Date();
    const CUTOFF_MINUTES = 10; // 10分钟内更新的任务才自动执行
    
    const pendingProjects = [...new Set(status.queue.pending.map(t => t.project_id))];
    
    for (const projectId of pendingProjects) {
      if (status.queue.in_progress[projectId] || agentExecutor.executingProjects.has(projectId)) {
        continue;
      }
      
      // 获取该项目的第一个待处理任务
      const task = status.queue.pending.find(t => t.project_id === projectId);
      if (!task) continue;
      
      // 检查任务是否最近更新过
      const taskUpdated = new Date(task.updated_at || task.created_at);
      const minutesSinceUpdate = (now - taskUpdated) / 1000 / 60;
      
      if (minutesSinceUpdate <= CUTOFF_MINUTES) {
        console.log(`[TaskMonitor] 检测到 ${projectId} 有新待处理任务 (${minutesSinceUpdate.toFixed(1)}分钟前)，触发执行`);
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
