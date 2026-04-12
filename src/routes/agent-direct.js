/**
 * Agent 直连 API - 后端直接下发需求并执行
 * 
 * 使用场景：
 * 1. 系统检测到问题（如慢查询、内存泄漏）自动创建需求并修复
 * 2. 定时任务触发优化（如清理日志、压缩图片）
 * 3. 其他 AI Agent 直接通过 API 下发需求
 */
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');
const { getTaskQueue } = require('../core/task-queue');
const { broadcast } = require('../websocket/broadcast');

const router = express.Router();

/**
 * 创建需求并直接执行（闭环模式）
 * POST /api/agent/direct
 * 
 * Body: {
 *   project_id: "personalwork",
 *   name: "优化数据库查询",
 *   description: "检测到慢查询，自动优化索引",
 *   category: "Backend",
 *   auto_execute: true,      // 是否立即执行
 *   record_only: false       // 仅记录不执行（false=闭环执行）
 * }
 */
router.post('/direct', async (req, res) => {
  const { 
    project_id, 
    name, 
    description, 
    category = 'Feature',
    auto_execute = true,
    record_only = false 
  } = req.body;

  if (!project_id || !name) {
    return res.status(400).json({ error: 'project_id 和 name 不能为空' });
  }

  try {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === project_id);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const devStatePath = path.join(project.path, 'dev_state.json');
    const devData = await fs.readFile(devStatePath, 'utf-8');
    const devState = JSON.parse(devData);

    // 生成新ID - 使用全局唯一ID
    const taskQueue = getTaskQueue();
    const newId = await taskQueue.generateGlobalFeatureId();
    
    const now = new Date().toISOString();
    
    const newFeature = {
      id: newId,
      name: name,
      description: description || '',
      status: record_only ? 'Pending' : 'Completed',  // 闭环直接标记完成
      category: category,
      source: 'backend',           // 来源标记
      auto_completed: !record_only, // 是否自动闭环
      created_at: now,
      updated_at: now
    };

    // 如果不是仅记录，添加执行信息
    if (!record_only) {
      newFeature.execution = {
        agent: 'kimi',
        agent_id: req.headers['x-agent-id'] || 'system',
        started_at: now,
        completed_at: now,  // 即时完成
        duration_seconds: 0,
        result_summary: 'AI自动闭环执行完成'
      };
    }

    // 写入 dev_state
    devState.feature_list = devState.feature_list || [];
    devState.feature_list.push(newFeature);

    // 添加变更日志
    devState.changelog = devState.changelog || [];
    devState.changelog.unshift({
      id: `LOG${Date.now()}`,
      timestamp: now,
      type: record_only ? 'backend_create' : 'backend_auto_complete',
      message: `[Backend] ${record_only ? '创建' : '自动完成'}: ${name}`,
      details: `来源: 后端API调用, ID: ${newId}`
    });

    await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));

    let task = null;
    if (record_only && auto_execute) {
      const taskQueue = getTaskQueue();
      const { getAgentExecutor } = require('../core/agent-executor');
      if (taskQueue.getExecutingTask(project_id)) {
        await taskQueue.enqueueFeature(project_id, newFeature.id);
      } else {
        const claimResult = await taskQueue.claimTask(project_id, {
          agent_id: 'backend',
          agent_name: 'Backend Direct'
        }, { featureId: newFeature.id });
        if (claimResult.success) {
          task = claimResult.task;
          getAgentExecutor().executeTask(project_id, claimResult.task).catch((err) => {
            console.error('[agent-direct] executeTask:', err);
          });
        }
      }
    }

    // 广播更新
    broadcast('feature_created', { 
      project_id, 
      feature: newFeature,
      source: 'backend'
    });

    res.json({
      success: true,
      feature: newFeature,
      task: task,
      message: record_only 
        ? '需求已创建，等待人工触发' 
        : '需求已创建并自动标记完成（AI闭环）'
    });

  } catch (err) {
    console.error('[AgentDirect] 创建需求失败:', err);
    res.status(500).json({ error: '创建失败', message: err.message });
  }
});

/**
 * 批量创建并执行需求
 * POST /api/agent/direct/batch
 */
router.post('/direct/batch', async (req, res) => {
  const { project_id, features } = req.body;
  
  if (!project_id || !Array.isArray(features)) {
    return res.status(400).json({ error: '参数错误' });
  }

  const results = [];
  for (const feature of features) {
    try {
      // 复用单条逻辑
      const result = await createDirectFeature(project_id, feature);
      results.push({ success: true, feature: result });
    } catch (err) {
      results.push({ success: false, error: err.message, feature });
    }
  }

  res.json({
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  });
});

/**
 * 获取后端创建的需求统计
 * GET /api/agent/direct/stats?project_id=xxx
 */
router.get('/direct/stats', async (req, res) => {
  const { project_id } = req.query;
  
  try {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === project_id);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const devStatePath = path.join(project.path, 'dev_state.json');
    const devData = await fs.readFile(devStatePath, 'utf-8');
    const devState = JSON.parse(devData);

    const backendFeatures = devState.feature_list?.filter(f => f.source === 'backend') || [];
    
    res.json({
      project_id,
      total_backend_features: backendFeatures.length,
      auto_completed: backendFeatures.filter(f => f.auto_completed).length,
      pending: backendFeatures.filter(f => f.status === 'Pending').length,
      by_category: backendFeatures.reduce((acc, f) => {
        acc[f.category] = (acc[f.category] || 0) + 1;
        return acc;
      }, {}),
      recent: backendFeatures.slice(-5).map(f => ({
        id: f.id,
        name: f.name,
        status: f.status,
        auto_completed: f.auto_completed,
        created_at: f.created_at
      }))
    });

  } catch (err) {
    res.status(500).json({ error: '统计失败', message: err.message });
  }
});

// 辅助函数：创建直连需求
async function createDirectFeature(projectId, featureData) {
  const config = getConfig();
  const project = config.monitored_projects.find(p => p.id === projectId);
  
  const devStatePath = path.join(project.path, 'dev_state.json');
  const devData = await fs.readFile(devStatePath, 'utf-8');
  const devState = JSON.parse(devData);

  // 生成新ID - 使用全局唯一ID
  const taskQueue = getTaskQueue();
  const newId = await taskQueue.generateGlobalFeatureId();
  const now = new Date().toISOString();

  const newFeature = {
    id: newId,
    name: featureData.name,
    description: featureData.description || '',
    status: featureData.record_only ? 'Pending' : 'Completed',
    category: featureData.category || 'Feature',
    source: 'backend',
    auto_completed: !featureData.record_only,
    created_at: now,
    updated_at: now
  };

  if (!featureData.record_only) {
    newFeature.execution = {
      agent: 'kimi',
      started_at: now,
      completed_at: now,
      result_summary: 'AI自动闭环执行'
    };
  }

  devState.feature_list.push(newFeature);
  await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));

  return newFeature;
}

module.exports = router;
