/**
 * 项目相关路由
 */
const express = require('express');
const path = require('path');
const { getConfig, saveConfig } = require('../config');
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getStateSync } = require('../core/state-sync');
const { getDeployServiceManager } = require('../services/deploy-manager');
const { broadcast } = require('../websocket/broadcast');
const { normalizeToolType, scanProjects, readProjectData, DEFAULT_TOOL_TYPE } = require('./utils');

function createProjectRoutes() {
  const router = express.Router();
  const taskQueue = getTaskQueue();
  const agentExecutor = getAgentExecutor();
  const stateSync = getStateSync();
  const deployServiceManager = getDeployServiceManager();

  // 健康检查
  router.get('/health', async (req, res) => {
    const queueStatus = await taskQueue.getStatus();
    res.json({
      status: 'ok',
      version: '2.2',
      app: getConfig().app,
      queue: queueStatus,
      executor: {
        executing_projects: [...agentExecutor.executingProjects],
        active_processes: Object.keys(agentExecutor.processes)
      },
      timestamp: new Date().toISOString()
    });
  });

  // 项目列表
  router.get('/projects', async (req, res) => {
    const config = getConfig();
    const projects = await scanProjects();
    const monitored = config.monitored_projects || [];

    const existingProjectIds = new Set(projects.map(p => p.id.toLowerCase()));

    const validMonitored = [];
    const seenIds = new Set();

    for (const m of monitored) {
      const mIdLower = m.id.toLowerCase();

      if (seenIds.has(mIdLower)) {
        console.log(`[项目列表] 跳过重复项目: ${m.id}`);
        continue;
      }

      const idExists = existingProjectIds.has(mIdLower);
      let pathExists = false;
      if (!idExists && m.path) {
        try {
          const fs = require('fs').promises;
          await fs.access(m.path);
          pathExists = true;
        } catch {
          pathExists = false;
        }
      }

      if (idExists || pathExists) {
        m.default_tool_type = normalizeToolType(m.default_tool_type, DEFAULT_TOOL_TYPE);
        seenIds.add(mIdLower);
        validMonitored.push(m);
      } else {
        console.log(`[项目列表] 清理已删除的项目: ${m.id} (路径: ${m.path})`);
      }
    }

    if (validMonitored.length !== monitored.length) {
      config.monitored_projects = validMonitored;
      await saveConfig();
    }

    const merged = [...validMonitored];
    for (const p of projects) {
      if (!merged.find(m => m.id.toLowerCase() === p.id.toLowerCase())) {
        merged.push({ ...p, active: false, auto_detected: true });
      }
    }

    res.json({ projects: merged, total: merged.length, active: merged.filter(p => p.active !== false).length });
  });

  // 单个项目详情
  router.get('/projects/:projectId', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const project = config.monitored_projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: '项目不存在', projectId });
    }

    const data = await readProjectData(project);
    res.json(data);
  });

  // 项目仪表板
  router.get('/projects/:projectId/dashboard', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const project = config.monitored_projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const fullData = await readProjectData(project);
    const devState = fullData.data.dev_state || {};
    const backlog = fullData.data.user_backlog || {};

    const queueStatus = await taskQueue.getStatus(projectId);

    const featureList = [...(devState.feature_list || [])];
    const executingTask = queueStatus.executing;
    let needSave = false;

    if (executingTask && executingTask.feature_id) {
      const featureIndex = featureList.findIndex(f => f.id === executingTask.feature_id);
      if (featureIndex !== -1) {
        if (featureList[featureIndex].status !== 'In_Progress') {
          console.log(`[API] 同步状态: ${projectId}/${executingTask.feature_id} -> In_Progress`);
          featureList[featureIndex].status = 'In_Progress';
          needSave = true;
        }
      }
    }

    for (const feature of featureList) {
      if (feature.status === 'In_Progress') {
        if (!executingTask || executingTask.feature_id !== feature.id) {
          console.log(`[API] 清理不一致状态: ${projectId}/${feature.id} In_Progress -> Queued`);
          feature.status = 'Queued';
          needSave = true;
        }
      }
    }

    if (needSave) {
      try {
        const fs = require('fs').promises;
        const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
        const updatedDevState = { ...devState, feature_list: featureList };
        await fs.writeFile(devStatePath, JSON.stringify(updatedDevState, null, 2));
        console.log(`[API] 已保存状态变更到 ${devStatePath}`);
      } catch (err) {
        console.error(`[API] 保存 dev_state.json 失败:`, err.message);
      }
    }

    const deployServices = await deployServiceManager.getRunningServices(projectId);

    res.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        tech_stack: project.tech_stack,
        default_tool_type: normalizeToolType(project.default_tool_type, DEFAULT_TOOL_TYPE)
      },
      feature_list: featureList,
      current_context: devState.current_context || {},
      changelog: devState.changelog || [],
      backlog_items: backlog.items || [],
      queue: queueStatus,
      deploy_services: deployServices
    });
  });

  // 状态同步
  router.post('/sync/:projectId', async (req, res) => {
    try {
      await stateSync.syncProjectState(req.params.projectId);
      res.json({ success: true, message: '状态已同步' });
    } catch (err) {
      res.status(500).json({ error: '同步失败', message: err.message });
    }
  });

  return router;
}

module.exports = { createProjectRoutes };
