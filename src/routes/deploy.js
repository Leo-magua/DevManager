/**
 * 部署服务管理与项目部署控制路由
 */
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const { getConfig } = require('../config');
const { getNginxManager } = require('../services/nginx-manager');
const { getDeployServiceManager } = require('../services/deploy-manager');

function createDeployRoutes() {
  const router = express.Router();
  const nginxManager = getNginxManager();
  const deployServiceManager = getDeployServiceManager();
  const runningProjects = new Map(); // projectId -> {pid, startTime, port}

  async function waitForPort(port, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await nginxManager.isPortInUse(port)) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  // 部署服务管理
  router.get('/:projectId/services', async (req, res) => {
    const { projectId } = req.params;
    const services = await deployServiceManager.getRunningServices(projectId);
    res.json({ project_id: projectId, services, count: services.length });
  });

  router.post('/:projectId/services/:taskId/stop', async (req, res) => {
    const { projectId, taskId } = req.params;
    const result = await deployServiceManager.stopService(projectId, taskId);
    res.json(result);
  });

  router.post('/:projectId/services/stop-all', async (req, res) => {
    const { projectId } = req.params;
    const result = await deployServiceManager.stopAllServices(projectId);
    res.json(result);
  });

  router.get('/running', async (req, res) => {
    const configs = nginxManager.getAllDeployConfigs();
    const running = [];

    for (const config of configs) {
      const isRunning = await nginxManager.isPortInUse(config.port);
      if (isRunning) {
        running.push({
          project_id: config.project_id,
          project_name: config.project_name,
          port: config.port,
          pid: runningProjects.get(config.project_id)?.pid || null
        });
      }
    }

    res.json({ count: running.length, projects: running });
  });

  // 项目部署控制
  router.get('/:projectId/status', async (req, res) => {
    const { projectId } = req.params;
    const deployConfig = nginxManager.getDeployConfig(projectId);

    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }

    const isRunning = await nginxManager.isPortInUse(deployConfig.port);

    res.json({
      project_id: projectId,
      port: deployConfig.port,
      running: isRunning,
      pid: runningProjects.get(projectId)?.pid || null,
      start_time: runningProjects.get(projectId)?.startTime || null
    });
  });

  router.post('/:projectId/start', async (req, res) => {
    const { projectId } = req.params;
    const { port: customPort } = req.body || {};

    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const deployConfig = nginxManager.getDeployConfig(projectId);
    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }

    if (customPort && customPort !== deployConfig.port) {
      await nginxManager.updateDeployConfig(projectId, { port: customPort });
      await nginxManager.saveNginxConfig();
      deployConfig.port = customPort;
    }

    const isRunning = await nginxManager.isPortInUse(deployConfig.port);
    if (isRunning) {
      return res.json({
        success: true,
        message: '项目已在运行',
        port: deployConfig.port,
        already_running: true
      });
    }

    const startCmd = nginxManager.generateStartCommand(project, deployConfig);

    try {
      const logDir = path.join(__dirname, '../..', 'logs', 'deploy');
      fsSync.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `${projectId}.log`);
      const logFd = fsSync.openSync(logPath, 'a');
      fsSync.writeSync(logFd, `\n[${new Date().toISOString()}] ${startCmd.command}\n[cwd] ${startCmd.cwd}\n`);

      const child = spawn(startCmd.command, {
        cwd: startCmd.cwd,
        env: { ...process.env, ...startCmd.env },
        detached: true,
        stdio: ['ignore', logFd, logFd],
        shell: true
      });

      child.unref();
      fsSync.closeSync(logFd);

      runningProjects.set(projectId, {
        pid: child.pid,
        startTime: new Date().toISOString(),
        port: deployConfig.port
      });
      deployServiceManager.recordPid(projectId, 'deploy', child.pid);

      console.log(`[Deploy] 启动项目 ${projectId} PID: ${child.pid} 端口: ${deployConfig.port}`);

      const started = await waitForPort(deployConfig.port);
      if (!started) {
        return res.status(500).json({
          success: false,
          error: `启动命令已执行，但端口 ${deployConfig.port} 未在 10 秒内监听`,
          pid: child.pid,
          port: deployConfig.port,
          command: startCmd.command,
          cwd: startCmd.cwd,
          log: logPath
        });
      }

      res.json({
        success: true,
        message: '项目已启动',
        pid: child.pid,
        port: deployConfig.port,
        command: startCmd.command,
        cwd: startCmd.cwd,
        log: logPath
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/:projectId/stop', async (req, res) => {
    const { projectId } = req.params;

    const deployConfig = nginxManager.getDeployConfig(projectId);
    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }

    try {
      const { stdout } = await execAsync(`lsof -t -i:${deployConfig.port}`);
      const pids = stdout.trim().split('\n');

      for (const pid of pids) {
        if (pid) {
          process.kill(parseInt(pid), 'SIGTERM');
          console.log(`[Deploy] 停止项目 ${projectId} PID: ${pid}`);
        }
      }

      runningProjects.delete(projectId);

      res.json({ success: true, message: '项目已停止', killed_pids: pids });
    } catch (err) {
      res.json({ success: true, message: '项目未运行或已停止' });
    }
  });

  router.post('/:projectId/update-port', async (req, res) => {
    const { projectId } = req.params;
    const { port: newPort } = req.body;

    if (!newPort || newPort < 1024 || newPort > 65535) {
      return res.status(400).json({ error: '无效的端口号 (1024-65535)' });
    }

    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }

    const deployConfig = nginxManager.getDeployConfig(projectId);
    const oldPort = deployConfig?.port;

    await nginxManager.updateDeployConfig(projectId, { port: newPort });
    await nginxManager.saveNginxConfig();

    const updatedFiles = [];

    if (deployConfig?.template === 'python') {
      const pyFiles = ['production_server.py', 'server.py', 'app.py'];
      for (const pyFile of pyFiles) {
        const pyPath = path.join(project.path, pyFile);
        try {
          let content = await fs.readFile(pyPath, 'utf-8');
          const originalContent = content;

          content = content.replace(
            /\(\s*["']0\.0\.0\.0["']\s*,\s*\d+\s*\)/,
            `("0.0.0.0", ${newPort})`
          );
          content = content.replace(
            /^(\s*port\s*=\s*)\d+/m,
            `$1${newPort}`
          );

          if (content !== originalContent) {
            await fs.writeFile(pyPath, content, 'utf-8');
            updatedFiles.push(pyFile);
          }
        } catch {}
      }
    } else if (deployConfig?.template === 'vite' || deployConfig?.template === 'nodejs') {
      const pkgPath = path.join(project.path, 'package.json');
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        let modified = false;

        for (const scriptName of ['start', 'preview', 'dev']) {
          if (pkg.scripts?.[scriptName]) {
            const original = pkg.scripts[scriptName];
            pkg.scripts[scriptName] = original.replace(
              /--port\s+\d+/,
              `--port ${newPort}`
            );
            if (pkg.scripts[scriptName] !== original) modified = true;
          }
        }

        if (modified) {
          await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
          updatedFiles.push('package.json');
        }
      } catch {}
    }

    res.json({
      success: true,
      message: '端口已更新',
      project_id: projectId,
      old_port: oldPort,
      new_port: newPort,
      updated_files: updatedFiles,
      note: '请重新启动项目以应用新端口'
    });
  });

  return router;
}

module.exports = { createDeployRoutes };
