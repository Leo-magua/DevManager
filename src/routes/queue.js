/**
 * 任务队列相关路由
 */
const express = require('express');
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const terminalBuffer = require('../websocket/terminal-buffer');

function createQueueRoutes() {
  const router = express.Router();
  const taskQueue = getTaskQueue();
  const agentExecutor = getAgentExecutor();

  router.get('/queue', async (req, res) => {
    const status = await taskQueue.getStatus();
    res.json(status);
  });

  router.get('/queue/:projectId', async (req, res) => {
    const status = await taskQueue.getStatus(req.params.projectId);
    res.json(status);
  });

  router.post('/queue/claim', async (req, res) => {
    const { project_id, agent_id, agent_name, auto_execute = true } = req.body;

    if (project_id) {
      const result = await taskQueue.claimTask(project_id, { agent_id, agent_name });

      if (result.success && auto_execute) {
        console.log(`[API] 任务认领成功，自动触发执行: ${project_id} - ${result.task.feature_name}`);
        agentExecutor.executeTask(project_id, result.task).catch((err) => {
          console.error('[API] 认领后自动执行失败:', err);
        });
      }

      res.json(result);
    } else {
      const result = await taskQueue.claimAnyTask({ agent_id, agent_name });
      res.json(result);
    }
  });

  router.post('/queue/complete', async (req, res) => {
    const { project_id, result, files_changed } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }

    const completion = await taskQueue.completeTask(project_id, {
      message: result,
      files_changed: files_changed || [],
      completed_at: new Date().toISOString()
    });

    agentExecutor.executingProjects.delete(project_id);
    console.log("[API] /queue/complete triggered: cleared lock for " + project_id + ", promoting next queued task");
    setTimeout(() => {
      agentExecutor.tryExecute(project_id);
    }, 500);

    res.json(completion);
  });

  router.post('/queue/error', async (req, res) => {
    const { project_id, error, retry } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }

    const result = await taskQueue.reportError(project_id, error, retry);
    res.json(result);
  });

  router.post('/queue/log', async (req, res) => {
    const { project_id, type, message, data } = req.body;

    if (!project_id || !type || !message) {
      return res.status(400).json({ error: 'project_id、type和message不能为空' });
    }

    const result = await taskQueue.addLog(project_id, type, message, data);
    res.json(result);
  });

  router.get('/queue/logs/:projectId', (req, res) => {
    const logs = taskQueue.getCurrentLogs(req.params.projectId);
    res.json(logs);
  });

  // 暂停控制
  router.get('/queue/pause', (req, res) => {
    res.json({ paused: taskQueue.isPaused() });
  });

  router.post('/queue/pause', async (req, res) => {
    const { paused } = req.body;
    if (typeof paused !== 'boolean') {
      return res.status(400).json({ error: 'paused 必须是布尔值' });
    }
    const result = await taskQueue.setPaused(paused);
    res.json(result);
  });

  router.post('/queue/pause/toggle', async (req, res) => {
    const newState = !taskQueue.isPaused();
    const result = await taskQueue.setPaused(newState);
    res.json(result);
  });

  // 停止指定项目的当前任务
  router.post('/queue/:projectId/stop', async (req, res) => {
    const { projectId } = req.params;
    const { reason } = req.body || {};

    agentExecutor.stop(projectId);
    const result = await taskQueue.stopTask(projectId, reason || '用户手动停止');

    if (result.error) {
      return res.json({
        success: true,
        message: '执行已停止',
        warning: result.error
      });
    }

    res.json({
      success: true,
      message: '任务已停止',
      task: result.task
    });
  });

  // 停止所有正在执行的任务
  router.post('/queue/stop-all', async (req, res) => {
    const { reason } = req.body || {};
    const result = await taskQueue.stopAllTasks(reason || '用户手动停止所有任务');

    res.json({
      success: true,
      message: `已停止 ${result.stopped} 个任务`,
      results: result.results
    });
  });

  // 暂停当前任务（保留 Queued 状态，全局队列暂停）
  router.post('/queue/:projectId/pause-task', async (req, res) => {
    const { projectId } = req.params;

    const executing = taskQueue.getExecutingTask(projectId);
    if (!executing) {
      return res.status(400).json({ error: '当前没有执行中的任务' });
    }

    agentExecutor.stop(projectId);
    const result = await taskQueue.pauseTask(projectId);
    if (result.error) {
      return res.status(400).json(result);
    }

    taskQueue.setPaused(true);

    res.json({
      success: true,
      message: '任务已暂停，已保留在开发队列中。点击「继续」可恢复执行',
      task: result.task
    });
  });

  // 终端缓冲区 API
  router.get('/terminal/:projectId', (req, res) => {
    const { projectId } = req.params;
    const offset = parseInt(req.query.offset || '0', 10);

    const { data, offset: newOffset } = terminalBuffer.getBuffer(projectId, offset);
    const session = terminalBuffer.getSession(projectId);

    res.json({
      project_id: projectId,
      data: data,
      offset: newOffset,
      active: terminalBuffer.isActive(projectId),
      task_id: session?.taskId || null
    });
  });

  router.post('/terminal/:projectId/input', express.text({ type: '*/*' }), (req, res) => {
    const { projectId } = req.params;
    const input = req.body;

    const process = agentExecutor.processes[projectId];
    if (process && process.write) {
      process.write(input);
      res.json({ success: true });
    } else {
      res.status(409).json({ error: '没有正在运行的终端会话' });
    }
  });

  // 重置任务
  router.post('/queue/reset', async (req, res) => {
    const { project_id, reason = '手动重置' } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }

    await taskQueue.resetProjectTask(project_id, reason);
    res.json({ success: true, message: '任务已重置' });
  });

  return router;
}

module.exports = { createQueueRoutes };
