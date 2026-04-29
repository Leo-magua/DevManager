/**
 * Agent 执行控制与任务回调路由
 */
const express = require('express');
const { getConfig } = require('../config');
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getProjectScanner } = require('../core/project-scanner');
const { getStateSync } = require('../core/state-sync');

function createExecutorRoutes() {
  const router = express.Router();
  const taskQueue = getTaskQueue();
  const agentExecutor = getAgentExecutor();
  const projectScanner = getProjectScanner();
  const stateSync = getStateSync();

  // Agent 获取下一个任务
  router.get('/agent/next-task', async (req, res) => {
    const config = getConfig();
    const status = taskQueue.getStatus();

    const pendingTask = status.queue.pending.find(t => !status.queue.in_progress[t.project_id]);

    if (pendingTask) {
      res.json({
        has_task: true,
        task: pendingTask,
        instruction: `请执行任务: ${pendingTask.feature_name}`,
        context: {
          project_path: config.monitored_projects.find(p => p.id === pendingTask.project_id)?.path,
          feature_details: pendingTask
        }
      });
    } else if (status.pending_count > 0) {
      res.json({
        has_task: false,
        pending_count: status.pending_count,
        message: '有等待中的任务，但所有项目都已有任务在执行中',
        claim_endpoint: '/api/queue/claim'
      });
    } else {
      res.json({
        has_task: false,
        pending_count: 0,
        message: '当前没有待处理的任务'
      });
    }
  });

  // 手动触发执行
  router.post('/executor/trigger', async (req, res) => {
    const { project_id } = req.body;
    console.log(`[API] 手动触发任务执行: ${project_id || '任意项目'}`);
    agentExecutor.tryExecute(project_id);
    res.json({ success: true, message: '已触发任务执行' });
  });

  // 停止执行
  router.post('/executor/stop', async (req, res) => {
    const { project_id } = req.body;
    console.log(`[API] 停止执行: ${project_id || '所有项目'}`);

    if (project_id) {
      agentExecutor.stop(project_id);
    } else {
      for (const pid of agentExecutor.executingProjects) {
        agentExecutor.stop(pid);
      }
    }

    res.json({ success: true, message: '已停止执行' });
  });

  // 项目扫描
  router.post('/scan', async (req, res) => {
    const { auto_scan, interval } = req.body || {};

    try {
      const results = await projectScanner.scan();

      if (typeof auto_scan !== 'undefined') {
        if (auto_scan) {
          projectScanner.startAutoScan(interval || 5);
        } else {
          projectScanner.stopAutoScan();
        }
      }

      res.json({
        success: true,
        results,
        auto_scan: projectScanner.getStatus().auto_scan
      });
    } catch (err) {
      res.status(500).json({ error: '扫描失败', message: err.message });
    }
  });

  router.get('/scan/status', (req, res) => {
    res.json(projectScanner.getStatus());
  });

  router.post('/scan/settings', async (req, res) => {
    const { auto_scan, interval = 5 } = req.body;

    try {
      if (auto_scan) {
        projectScanner.startAutoScan(interval);
      } else {
        projectScanner.stopAutoScan();
      }

      const config = getConfig();
      config.scan_settings = {
        auto_scan: !!auto_scan,
        interval: interval,
        updated_at: new Date().toISOString()
      };
      await require('../config').saveConfig();

      res.json({
        success: true,
        settings: config.scan_settings,
        status: projectScanner.getStatus()
      });
    } catch (err) {
      res.status(500).json({ error: '设置失败', message: err.message });
    }
  });

  // 任务完成回调（供 AI Agent 调用）
  router.post('/tasks/:taskId/complete', async (req, res) => {
    const { taskId } = req.params;
    const { message = '任务完成' } = req.body;

    console.log(`[API] 任务完成回调: ${taskId}, message: ${message}`);

    const config = getConfig();
    let targetProject = null;
    let targetTask = null;

    for (const project of config.monitored_projects) {
      const executing = taskQueue.getExecutingTask(project.id);
      if (executing && executing.id === taskId) {
        targetProject = project;
        targetTask = executing;
        break;
      }
    }

    try {
      const result = targetProject && targetTask
        ? await taskQueue.completeTask(targetProject.id, {
            message: message,
            files_changed: [],
            completed_at: new Date().toISOString(),
            completed_by_agent: true
          })
        : await taskQueue.completeTaskByTaskId(taskId, {
            message: message,
            files_changed: [],
            completed_at: new Date().toISOString(),
            completed_by_agent: true
          });

      if (result.error) {
        return res.status(404).json(result);
      }

      const resolvedProjectId = targetProject?.id || result.project_id;
      agentExecutor.executingProjects.delete(resolvedProjectId);
      console.log("[API] /complete 触发：强制清除 " + resolvedProjectId + " 的执行锁，准备推进下一个排队任务");
      setTimeout(() => {
        agentExecutor.tryExecute(resolvedProjectId);
      }, 500);

      res.json({
        success: true,
        message: '任务状态已更新为完成',
        project_id: resolvedProjectId,
        task: targetTask || result.task,
        recovered: !!result.recovered
      });
    } catch (err) {
      res.status(500).json({
        error: '更新任务状态失败',
        message: err.message
      });
    }
  });

  // 任务失败回调
  router.post('/tasks/:taskId/fail', async (req, res) => {
    const { taskId } = req.params;
    const { error = '任务执行失败', retry = true } = req.body;

    console.log(`[API] 任务失败回调: ${taskId}, error: ${error}, retry: ${retry}`);

    const config = getConfig();
    let targetProject = null;
    let targetTask = null;

    for (const project of config.monitored_projects) {
      const executing = taskQueue.getExecutingTask(project.id);
      if (executing && executing.id === taskId) {
        targetProject = project;
        targetTask = executing;
        break;
      }
    }

    try {
      const result = targetProject && targetTask
        ? await taskQueue.reportError(targetProject.id, error, retry)
        : await taskQueue.failTaskByTaskId(taskId, error, retry);

      if (result.error) {
        return res.status(404).json(result);
      }

      res.json({
        success: true,
        message: '任务失败状态已记录',
        project_id: targetProject?.id || result.project_id,
        task: targetTask || result.task,
        result
      });
    } catch (err) {
      res.status(500).json({
        error: '更新任务状态失败',
        message: err.message
      });
    }
  });

  return router;
}

module.exports = { createExecutorRoutes };
