/**
 * Nginx 部署管理路由
 */
const express = require('express');
const { getConfig } = require('../config');
const { getNginxManager } = require('../services/nginx-manager');

function createNginxRoutes() {
  const router = express.Router();
  const nginxManager = getNginxManager();

  router.get('/status', async (req, res) => {
    const status = await nginxManager.getStatus();
    res.json(status);
  });

  router.get('/deploy-configs', (req, res) => {
    const configs = nginxManager.getAllDeployConfigs();
    res.json({ count: configs.length, configs });
  });

  router.get('/deploy-configs/:projectId', (req, res) => {
    const { projectId } = req.params;
    const config = nginxManager.getDeployConfig(projectId);
    if (!config) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }
    res.json(config);
  });

  router.patch('/deploy-configs/:projectId', async (req, res) => {
    const { projectId } = req.params;
    const updates = req.body;

    const result = await nginxManager.updateDeployConfig(projectId, updates);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    await nginxManager.saveNginxConfig();

    res.json({
      success: true,
      message: '部署配置已更新，请重载 Nginx 生效',
      config: result.config
    });
  });

  router.post('/generate-config', async (req, res) => {
    const result = await nginxManager.saveNginxConfig();
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      message: 'Nginx 配置已生成',
      path: result.path,
      valid: result.valid
    });
  });

  router.post('/validate', async (req, res) => {
    const valid = await nginxManager.validateConfig();
    res.json({ valid, status: nginxManager.configStatus });
  });

  router.post('/reload', async (req, res) => {
    const result = await nginxManager.reloadNginx();
    if (!result.success) {
      return res.status(500).json(result);
    }
    res.json(result);
  });

  router.get('/start-command/:projectId', (req, res) => {
    const { projectId } = req.params;
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const deployConfig = nginxManager.getDeployConfig(projectId);
    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }

    const startCommand = nginxManager.generateStartCommand(project, deployConfig);

    res.json({
      project_id: projectId,
      project_name: project.name,
      ...startCommand
    });
  });

  // 一键应用所有配置
  router.post('/apply', async (req, res) => {
    try {
      const saveResult = await nginxManager.saveNginxConfig();
      if (!saveResult.success) {
        return res.status(500).json({ success: false, step: 'generate', error: saveResult.error });
      }

      const valid = await nginxManager.validateConfig();
      if (!valid) {
        return res.status(500).json({
          success: false,
          step: 'validate',
          error: 'Nginx 配置验证失败',
          status: nginxManager.configStatus
        });
      }

      const reloadResult = await nginxManager.reloadNginx();
      if (!reloadResult.success) {
        return res.status(500).json({ success: false, step: 'reload', error: reloadResult.error });
      }

      res.json({
        success: true,
        message: 'Nginx 配置已应用并生效',
        config_path: saveResult.path,
        projects: nginxManager.getAllDeployConfigs().length
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createNginxRoutes };
