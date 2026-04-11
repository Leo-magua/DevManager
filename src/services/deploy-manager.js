/**
 * 部署服务管理器
 */
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config');

class DeployServiceManager {
  constructor() {
    this.pidsDir = path.join(__dirname, '../..', 'data', 'pids');
    this.ensurePidsDir();
  }

  ensurePidsDir() {
    if (!fs.existsSync(this.pidsDir)) {
      fs.mkdirSync(this.pidsDir, { recursive: true });
    }
  }

  recordPid(projectId, taskId, pid) {
    const pidFile = path.join(this.pidsDir, `${projectId}-${taskId}.pid`);
    fs.writeFileSync(pidFile, String(pid));
  }

  getRunningServices(projectId) {
    const config = getConfig();
    const services = [];
    const seenPids = new Set();
    
    const project = config.monitored_projects.find(p => p.id === projectId);
    const projectPath = project ? project.path : path.join(config.projects_root, projectId);
    
    const pidDirs = [
      this.pidsDir,
      path.join(projectPath, '.devmanager', 'pids')
    ];
    
    for (const pidDir of pidDirs) {
      try {
        if (!fs.existsSync(pidDir)) continue;
        
        const files = fs.readdirSync(pidDir);
        for (const file of files) {
          if (!file.endsWith('.pid')) continue;
          
          const taskId = file.replace('.pid', '');
          const pidFile = path.join(pidDir, file);
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
          
          if (seenPids.has(pid)) continue;
          seenPids.add(pid);
          
          const isRunning = this.isProcessRunning(pid);
          if (isRunning) {
            services.push({ taskId, pid, status: 'running' });
          } else {
            try { fs.unlinkSync(pidFile); } catch {}
          }
        }
      } catch (err) {}
    }
    
    return services;
  }

  isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  stopService(projectId, taskId) {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    const projectPath = project ? project.path : path.join(config.projects_root, projectId);
    
    const pidFiles = [
      path.join(this.pidsDir, `${projectId}-${taskId}.pid`),
      path.join(projectPath, '.devmanager', 'pids', `${taskId}.pid`)
    ];
    
    for (const pidFile of pidFiles) {
      try {
        if (fs.existsSync(pidFile)) {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
          process.kill(pid, 'SIGTERM');
          fs.unlinkSync(pidFile);
          return { success: true, message: `服务已停止 (PID: ${pid})` };
        }
      } catch (err) {}
    }
    
    return { success: false, error: '未找到服务记录' };
  }

  stopAllServices(projectId) {
    const services = this.getRunningServices(projectId);
    const results = [];
    
    for (const svc of services) {
      results.push(this.stopService(projectId, svc.taskId));
    }
    
    return { stopped: results.length, results };
  }
}

const deployServiceManager = new DeployServiceManager();

module.exports = {
  deployServiceManager,
  getDeployServiceManager: () => deployServiceManager
};
