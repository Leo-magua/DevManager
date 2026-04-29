/**
 * AI 服务路由
 */
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');
const { getAIService } = require('../services/ai-service');

function createAIRoutes() {
  const router = express.Router();
  const aiService = getAIService();

  // 测试AI连接
  router.post('/test-connection', async (req, res) => {
    try {
      const settings = req.body;
      if (!settings.apiKey) {
        return res.status(400).json({ error: 'API Key不能为空' });
      }
      const result = await aiService.testConnection(settings);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // AI解析需求
  router.post('/parse-requirement', async (req, res) => {
    const { input, project_id, settings } = req.body;

    if (!input || !input.trim()) {
      return res.status(400).json({ error: '需求描述不能为空' });
    }

    if (!settings || !settings.apiKey) {
      return res.status(400).json({ error: 'API Key未配置' });
    }

    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === project_id);

      let projectContext = {
        projectName: project?.name || project_id,
        techStack: project?.tech_stack || []
      };

      if (project) {
        try {
          const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
          const data = await fs.readFile(devStatePath, 'utf-8');
          const devState = JSON.parse(data);
          const features = devState.feature_list || [];

          projectContext.completedFeatures = features.filter(f => f.status === 'Completed');
          projectContext.inProgressFeatures = features.filter(f => f.status === 'In_Progress' || f.status === 'Queued');
          projectContext.pendingFeatures = features.filter(f => f.status === 'Pending' || !f.status);
        } catch {
          // 忽略读取错误
        }
      }

      const tasks = await aiService.parseRequirement(input, projectContext, settings);

      res.json({
        success: true,
        tasks: tasks,
        count: tasks.length
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createAIRoutes };
