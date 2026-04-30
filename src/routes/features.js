/**
 * 功能任务（看板）相关路由
 */
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { getConfig, saveConfig } = require('../config');
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getNLParser } = require('../services/nl-parser');
const { broadcast } = require('../websocket/broadcast');
const { SUPPORTED_TOOL_TYPES, normalizeToolType, DEFAULT_TOOL_TYPE } = require('./utils');
const { writeJsonAtomic } = require('../utils/atomic-write');

function createFeatureRoutes() {
  const router = express.Router();
  const taskQueue = getTaskQueue();
  const agentExecutor = getAgentExecutor();
  const nlParser = getNLParser();

  // 添加需求到 backlog 并创建功能任务
  router.post('/projects/:projectId/backlog', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const { title, description, category = 'Feature', auto_start = false } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: '需求标题不能为空' });
    }

    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    try {
      const backlogPath = path.join(project.path, project.key_files?.user_backlog || 'user_backlog.json');

      let backlog = { items: [] };
      try {
        const data = await fs.readFile(backlogPath, 'utf-8');
        backlog = JSON.parse(data);
      } catch {}

      const newItem = {
        id: `REQ${Date.now()}`,
        title: title.trim(),
        description: description?.trim() || '',
        category,
        status: 'New',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      backlog.items.unshift(newItem);
      backlog.updated_at = new Date().toISOString();
      await writeJsonAtomic(backlogPath, backlog);

      const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
      let devState = { feature_list: [], changelog: [] };
      try {
        const devData = await fs.readFile(devStatePath, 'utf-8');
        devState = JSON.parse(devData);
      } catch {}

      devState.feature_list = devState.feature_list || [];
      const newId = await taskQueue.generateGlobalFeatureId();

      const newFeature = {
        id: newId,
        name: title.trim(),
        description: description?.trim() || '',
        status: 'Pending',
        category,
        backlog_ref: newItem.id,
        created_at: new Date().toISOString()
      };

      devState.feature_list.push(newFeature);

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        id: `LOG${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'backlog',
        message: `[${project.name}] 新需求提交: ${title.trim()}`,
        details: `ID: ${newItem.id}${auto_start ? ', 已自动开始' : ''}`
      });

      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await writeJsonAtomic(devStatePath, devState);

      let task = null;
      if (auto_start) {
        if (taskQueue.getExecutingTask(projectId)) {
          await taskQueue.enqueueFeature(projectId, newFeature.id);
        } else {
          const claimResult = await taskQueue.claimTask(projectId, {
            agent_id: 'manual',
            agent_name: 'User Manual Start'
          }, { featureId: newFeature.id });
          if (claimResult.success) {
            task = claimResult.task;
            agentExecutor.executeTask(projectId, claimResult.task).catch((err) => {
              console.error('[API] backlog auto_start executeTask:', err);
            });
          }
        }
      }

      res.json({
        success: true,
        item: newItem,
        feature: newFeature,
        task: task,
        auto_started: auto_start
      });
    } catch (err) {
      res.status(500).json({ error: '添加需求失败', message: err.message });
    }
  });

  // 点击卡片触发开发
  router.post('/projects/:projectId/features/:featureId/start', async (req, res) => {
    const config = getConfig();
    const { projectId, featureId } = req.params;
    const body = req.body || {};
    const hasToolType = Object.prototype.hasOwnProperty.call(body, 'tool_type');

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (!feature) {
        return res.status(404).json({ error: '功能项不存在' });
      }

      if (hasToolType) {
        if (body.tool_type === null) {
          delete feature.tool_type;
        } else if (SUPPORTED_TOOL_TYPES.includes(body.tool_type)) {
          feature.tool_type = body.tool_type;
        } else {
          return res.status(400).json({ error: '无效的执行工具', allowed: [...SUPPORTED_TOOL_TYPES, null] });
        }
        feature.updated_at = new Date().toISOString();
        await writeJsonAtomic(devStatePath, devState);
      }

      const curSt = feature.status || 'Pending';
      if (curSt !== 'Pending' && curSt !== 'Queued') {
        return res.status(400).json({ error: '仅待处理或排队中的任务可由此启动', current_status: curSt });
      }

      const executing = taskQueue.getExecutingTask(projectId);
      if (executing) {
        if (curSt !== 'Pending') {
          return res.status(400).json({ error: '已有任务执行中', current: executing });
        }
        const enq = await taskQueue.enqueueFeature(projectId, featureId);
        if (enq.error) {
          return res.status(400).json(enq);
        }
        return res.json({
          success: true,
          queued: true,
          message: '已有任务执行中，此项已加入开发队列末尾',
          current: executing
        });
      }

      if (curSt === 'Queued') {
        const ordered = await taskQueue.getQueuedFeaturesInOrder(projectId);
        if (!ordered.length || ordered[0].id !== featureId) {
          return res.status(400).json({ error: '请等待队首任务执行完毕，或仅对「待处理」项使用开始开发' });
        }
      }

      const claimResult = await taskQueue.claimTask(projectId, {
        agent_id: 'manual',
        agent_name: 'User Manual Start'
      }, { featureId });

      if (claimResult.error) {
        return res.status(400).json({ error: claimResult.error });
      }

      const resolvedToolType = feature.tool_type || normalizeToolType(project.default_tool_type, DEFAULT_TOOL_TYPE);
      claimResult.task.toolType = resolvedToolType;
      claimResult.task.tool_type = resolvedToolType;
      agentExecutor.executeTask(projectId, claimResult.task).catch((err) => {
        console.error('[API] features/start executeTask:', err);
      });

      res.json({
        success: true,
        message: '任务已开始执行',
        task: claimResult.task,
        next_step: 'Agent自动执行中...'
      });

    } catch (err) {
      res.status(500).json({ error: '启动任务失败', message: err.message });
    }
  });

  // 修改默认工具
  router.put('/projects/:projectId/default-tool', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const { tool_type } = req.body || {};

    if (!SUPPORTED_TOOL_TYPES.includes(tool_type)) {
      return res.status(400).json({ error: '无效的默认执行工具', allowed: SUPPORTED_TOOL_TYPES });
    }

    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    project.default_tool_type = tool_type;
    await saveConfig();

    res.json({
      success: true,
      project: {
        id: project.id,
        default_tool_type: project.default_tool_type
      }
    });
  });

  // 调整开发队列中任务顺序
  router.put('/projects/:projectId/features/:featureId/reorder', async (req, res) => {
    const config = getConfig();
    const { projectId, featureId } = req.params;
    const { direction } = req.body || {};

    if (!['up', 'down'].includes(direction)) {
      return res.status(400).json({ error: 'direction 必须为 up 或 down' });
    }

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);
      const features = devState.feature_list || [];

      const queuedIndices = [];
      features.forEach((f, i) => {
        if (f.status === 'Queued') queuedIndices.push(i);
      });

      const posInQueue = queuedIndices.findIndex(i => features[i].id === featureId);
      if (posInQueue === -1) {
        return res.status(400).json({ error: '该任务不在开发队列中' });
      }

      let swapPos = -1;
      if (direction === 'up' && posInQueue > 0) {
        swapPos = posInQueue - 1;
      } else if (direction === 'down' && posInQueue < queuedIndices.length - 1) {
        swapPos = posInQueue + 1;
      }

      if (swapPos === -1) {
        return res.json({ success: true, message: '已到边界，无法移动', no_change: true });
      }

      const idxA = queuedIndices[posInQueue];
      const idxB = queuedIndices[swapPos];
      [features[idxA], features[idxB]] = [features[idxB], features[idxA]];

      devState.feature_list = features;
      await writeJsonAtomic(devStatePath, devState);
      broadcast('feature_updated', { project_id: projectId, feature_id: featureId });

      res.json({ success: true, message: '顺序已调整' });
    } catch (err) {
      res.status(500).json({ error: '调整失败', message: err.message });
    }
  });

  // 修改需求标题/描述/类别
  router.put('/projects/:projectId/features/:featureId/content', async (req, res) => {
    const config = getConfig();
    const { projectId, featureId } = req.params;
    const { name, description, category, tool_type } = req.body || {};

    if (name === undefined && description === undefined && category === undefined && tool_type === undefined) {
      return res.status(400).json({ error: '至少提供 name、description、category 或 tool_type 之一' });
    }

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);
      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (!feature) {
        return res.status(404).json({ error: '功能项不存在' });
      }

      if (typeof name === 'string') feature.name = name.trim() || feature.name;
      if (typeof description === 'string') feature.description = description;
      if (typeof category === 'string' && category.trim()) feature.category = category.trim();
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tool_type')) {
        if (tool_type === null) {
          delete feature.tool_type;
        } else if (SUPPORTED_TOOL_TYPES.includes(tool_type)) {
          feature.tool_type = tool_type;
        } else {
          return res.status(400).json({ error: '无效的执行工具', allowed: [...SUPPORTED_TOOL_TYPES, null] });
        }
      }
      feature.updated_at = new Date().toISOString();

      await writeJsonAtomic(devStatePath, devState);
      broadcast('feature_updated', { project_id: projectId, feature_id: featureId });

      res.json({ success: true, feature });
    } catch (err) {
      res.status(500).json({ error: '更新失败', message: err.message });
    }
  });

  // 看板批量操作
  router.post('/projects/:projectId/features/bulk-actions', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const { action } = req.body || {};
    const allowed = ['pending_to_progress', 'progress_to_pending', 'pause_in_progress'];

    if (!allowed.includes(action)) {
      return res.status(400).json({ error: '未知 action', allowed });
    }

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');

      if (action === 'pending_to_progress') {
        const raw = await fs.readFile(devStatePath, 'utf-8');
        const devState = JSON.parse(raw);
        devState.feature_list = devState.feature_list || [];
        let n = 0;
        for (const f of devState.feature_list) {
          const st = f.status || 'Pending';
          if (st === 'Pending' || !f.status) {
            f.status = 'Queued';
            f.updated_at = new Date().toISOString();
            n++;
          }
        }
        await writeJsonAtomic(devStatePath, devState);
        let started = false;
        if (taskQueue.isPaused()) {
          taskQueue.setPaused(false);
        }
        if (!taskQueue.isPaused() && !taskQueue.getExecutingTask(projectId)) {
          const next = await taskQueue.maybeStartNextFromQueue(projectId, {
            agent_id: 'bulk',
            agent_name: 'Bulk enqueue'
          });
          if (next.started && next.task) {
            agentExecutor.executeTask(projectId, next.task).catch((err) => {
              console.error('[API] bulk pending_to_progress executeTask:', err);
            });
            started = true;
          }
        }
        broadcast('features_bulk', { project_id: projectId, action, count: n, started });
        return res.json({
          success: true,
          action,
          updated: n,
          started,
          message: started
            ? `已将 ${n} 条加入开发队列，并已按顺序启动队首任务`
            : `已将 ${n} 条加入开发队列（队首未启动：可能已有执行中或队列已暂停）`
        });
      }

      if (action === 'progress_to_pending') {
        agentExecutor.stop(projectId);
        if (taskQueue.getExecutingTask(projectId)) {
          await taskQueue.stopTask(projectId, '批量退回待处理');
        }
        const raw = await fs.readFile(devStatePath, 'utf-8');
        const devState = JSON.parse(raw);
        devState.feature_list = devState.feature_list || [];
        let n = 0;
        for (const f of devState.feature_list) {
          if (f.status === 'In_Progress' || f.status === 'Queued') {
            f.status = 'Pending';
            f.updated_at = new Date().toISOString();
            n++;
          }
        }
        await writeJsonAtomic(devStatePath, devState);
        if (taskQueue.isPaused()) {
          taskQueue.setPaused(false);
        }
        broadcast('features_bulk', { project_id: projectId, action, count: n });
        return res.json({ success: true, action, updated: n, paused_reset: true, message: `已将 ${n} 条退回待处理` });
      }

      if (action === 'pause_in_progress') {
        taskQueue.setPaused(true);
        agentExecutor.stop(projectId);
        if (taskQueue.getExecutingTask(projectId)) {
          await taskQueue.stopTask(projectId, '暂停全部开发中任务');
        }
        broadcast('features_bulk', { project_id: projectId, action });
        return res.json({
          success: true,
          action,
          paused: true,
          message: '队列已暂停，并已尝试停止当前项目运行中的 Agent'
        });
      }
    } catch (err) {
      res.status(500).json({ error: '批量操作失败', message: err.message });
    }
  });

  // 批量创建功能任务
  router.post('/projects/:projectId/features/batch', async (req, res) => {
    const config = getConfig();
    const { projectId } = req.params;
    const { tasks, auto_start } = req.body;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: '任务列表不能为空' });
    }

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      devState.feature_list = devState.feature_list || [];
      const createdFeatures = [];

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const newId = await taskQueue.generateGlobalFeatureId();

        const newFeature = {
          id: newId,
          name: task.title,
          description: task.description || '',
          status: auto_start ? 'Queued' : 'Pending',
          category: task.category || 'Feature',
          created_from_ai: true,
          ai_input: req.body.input || '',
          created_at: new Date().toISOString()
        };

        devState.feature_list.push(newFeature);
        createdFeatures.push(newFeature);
      }

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        id: `LOG${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'nlp_create',
        message: `[AI] 批量创建 ${createdFeatures.length} 个需求`,
        details: `任务: ${createdFeatures.map(f => f.name).join(', ').substring(0, 100)}...`
      });

      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await writeJsonAtomic(devStatePath, devState);

      if (auto_start && createdFeatures.length > 0) {
        const next = await taskQueue.maybeStartNextFromQueue(projectId, {
          agent_id: 'ai-auto',
          agent_name: 'AI Auto Start'
        });
        if (next.started && next.task) {
          agentExecutor.executeTask(projectId, next.task).catch((err) => {
            console.error('[API] features/batch executeTask:', err);
          });
        }
      }

      broadcast('features_batch_created', {
        project_id: projectId,
        count: createdFeatures.length,
        features: createdFeatures
      });

      res.json({
        success: true,
        created: createdFeatures.length,
        features: createdFeatures,
        message: `成功创建 ${createdFeatures.length} 个需求`,
        auto_started: auto_start && createdFeatures.length > 0
      });

    } catch (err) {
      res.status(500).json({ error: '批量创建任务失败', message: err.message });
    }
  });

  // 删除任务
  router.delete('/projects/:projectId/features/:featureId', async (req, res) => {
    const config = getConfig();
    const { projectId, featureId } = req.params;

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      const featureIndex = devState.feature_list?.findIndex(f => f.id === featureId);
      if (featureIndex === -1 || featureIndex === undefined) {
        return res.status(404).json({ error: '功能项不存在' });
      }

      const executing = taskQueue.getExecutingTask(projectId);
      if (executing && executing.feature_id === featureId) {
        return res.status(400).json({ error: '任务正在执行中，无法删除' });
      }

      const deletedFeature = devState.feature_list.splice(featureIndex, 1)[0];

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        timestamp: new Date().toISOString(),
        type: 'system',
        message: `删除任务: ${deletedFeature.name}`,
        details: `任务ID: ${deletedFeature.id}`
      });

      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await writeJsonAtomic(devStatePath, devState);

      broadcast('feature_deleted', { project_id: projectId, feature_id: featureId });

      res.json({
        success: true,
        message: '任务已删除',
        feature: deletedFeature
      });

    } catch (err) {
      res.status(500).json({ error: '删除任务失败', message: err.message });
    }
  });

  // 更新任务状态
  router.put('/projects/:projectId/features/:featureId/status', async (req, res) => {
    const config = getConfig();
    const { projectId, featureId } = req.params;
    let { status, auto_start = true } = req.body;

    if (status === 'In_Progress') {
      status = 'Queued';
    }

    if (!['Pending', 'Queued', 'Completed'].includes(status)) {
      return res.status(400).json({ error: '无效的状态，必须是 Pending/Queued/Completed' });
    }

    try {
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (!feature) {
        return res.status(404).json({ error: '功能项不存在' });
      }

      const oldStatus = feature.status || 'Pending';

      if (status === 'Queued' && (oldStatus === 'Pending' || !feature.status)) {
        const enq = await taskQueue.enqueueFeature(projectId, featureId);
        if (enq.error) {
          return res.status(400).json(enq);
        }
        await taskQueue.addChangelog(projectId, 'status_change', `任务进入开发队列: ${feature.name}`, `${oldStatus} \u2192 Queued`);
        let taskStarted = false;
        if (auto_start) {
          const next = await taskQueue.maybeStartNextFromQueue(projectId, {
            agent_id: 'manual',
            agent_name: 'User drag'
          });
          if (next.started && next.task) {
            agentExecutor.executeTask(projectId, next.task).catch((err) => {
              console.error('[API] feature status executeTask:', err);
            });
            taskStarted = true;
          }
        }
        broadcast('feature_updated', { project_id: projectId, feature_id: featureId, changes: { status: 'Queued' } });
        return res.json({
          success: true,
          message: taskStarted ? '已进入开发队列并开始执行队首任务' : '已进入开发队列',
          task_started: taskStarted,
          feature: { id: featureId, old_status: oldStatus, new_status: 'Queued' }
        });
      }

      if (status === 'Queued' && oldStatus === 'Queued') {
        return res.json({
          success: true,
          message: '已在开发队列中',
          task_started: false,
          feature: { id: featureId, old_status: oldStatus, new_status: 'Queued' }
        });
      }

      if (status === 'Queued') {
        return res.status(400).json({ error: '只能从待处理进入开发队列' });
      }

      feature.status = status;
      feature.updated_at = new Date().toISOString();

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        timestamp: new Date().toISOString(),
        type: 'status_change',
        message: `任务状态变更: ${feature.name}`,
        details: `${oldStatus} \u2192 ${status}`
      });

      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await writeJsonAtomic(devStatePath, devState);

      broadcast('feature_updated', {
        project_id: projectId,
        feature_id: featureId,
        changes: { status }
      });

      res.json({
        success: true,
        message: '状态已更新',
        task_started: false,
        feature: { id: featureId, old_status: oldStatus, new_status: status }
      });
    } catch (err) {
      res.status(500).json({ error: '更新状态失败', message: err.message });
    }
  });

  // NLP 提交（在 features 模块，因为它创建 feature）
  router.post('/nlp/submit', async (req, res) => {
    const { input, project_id, auto_execute = true } = req.body;

    if (!input || !project_id) {
      return res.status(400).json({ error: '输入和项目ID不能为空' });
    }

    try {
      const config = getConfig();
      const parsed = await nlParser.parse(input, { projectId: project_id });

      const project = config.monitored_projects.find(p => p.id === project_id);
      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const devStatePath = path.join(project.path, 'dev_state.json');
      const devData = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(devData);

      const newId = await taskQueue.generateGlobalFeatureId();

      const newFeature = {
        id: newId,
        name: parsed.title,
        description: parsed.description,
        status: 'Pending',
        category: parsed.category,
        keywords: parsed.keywords,
        created_from_nlp: true,
        nlp_input: input,
        created_at: new Date().toISOString()
      };

      devState.feature_list = devState.feature_list || [];
      devState.feature_list.push(newFeature);

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        id: `LOG${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'nlp_create',
        message: `[NLP] 创建需求: ${parsed.title}`,
        details: `来源: "${input.substring(0, 50)}..."`
      });

      await writeJsonAtomic(devStatePath, devState);

      let task = null;
      if (auto_execute) {
        if (taskQueue.getExecutingTask(project_id)) {
          await taskQueue.enqueueFeature(project_id, newFeature.id);
        } else {
          const claimResult = await taskQueue.claimTask(project_id, {
            agent_id: 'nlp-auto',
            agent_name: 'NLP Auto Start'
          }, { featureId: newFeature.id });
          if (claimResult.success) {
            task = claimResult.task;
            agentExecutor.executeTask(project_id, claimResult.task).catch((err) => {
              console.error('[API] nlp/submit executeTask:', err);
            });
          }
        }
      }

      res.json({
        success: true,
        feature: newFeature,
        task,
        parsed,
        message: auto_execute ? '需求已创建并自动加入开发队列' : '需求已创建，等待开发'
      });

    } catch (err) {
      res.status(500).json({ error: '提交失败', message: err.message });
    }
  });

  return router;
}

module.exports = { createFeatureRoutes };
