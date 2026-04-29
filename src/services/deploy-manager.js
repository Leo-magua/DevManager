/**
 * 部署服务管理器
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
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

  /**
   * 检查端口是否被占用
   */
  async isPortInUse(port) {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} | grep LISTEN | wc -l`);
      return parseInt(stdout.trim()) > 0;
    } catch {
      return false;
    }
  }

  /**
   * 获取占用端口的进程信息
   */
  async getPortProcessInfo(port) {
    try {
      const { stdout } = await execAsync(`lsof -i :${port} -sTCP:LISTEN -t`);
      const pid = parseInt(stdout.trim());
      if (pid) {
        try {
          // 获取进程命令行信息
          const { stdout: cmdline } = await execAsync(`ps -p ${pid} -o command=`);
          return { pid, command: cmdline.trim() };
        } catch {
          return { pid, command: 'unknown' };
        }
      }
    } catch {}
    return null;
  }

  /**
   * 从项目配置中获取部署端口
   */
  getProjectPort(projectId) {
    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) return null;

      // 尝试读取 nginx 配置中的端口
      const nginxConfigPath = path.join(project.path, '.devmanager', 'nginx-config.json');
      if (fs.existsSync(nginxConfigPath)) {
        const deployConfig = JSON.parse(fs.readFileSync(nginxConfigPath, 'utf-8'));
        return deployConfig.port;
      }

      // 基于项目名生成确定性端口 (3000-9000)
      let hash = 0;
      for (let i = 0; i < projectId.length; i++) {
        hash = ((hash << 5) - hash) + projectId.charCodeAt(i);
        hash = hash & hash;
      }
      const portRange = 6000; // 3000-9000
      return 3000 + (Math.abs(hash) % portRange);
    } catch {
      return null;
    }
  }

  async getRunningServices(projectId) {
    const config = getConfig();
    const services = [];
    const seenPids = new Set();
    
    const project = config.monitored_projects.find(p => p.id === projectId);
    const projectPath = project ? project.path : path.join(config.projects_root, projectId);
    
    // 1. 检查 PID 文件（DevManager 启动的服务）
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
            services.push({ taskId, pid, status: 'running', source: 'pid_file' });
          } else {
            try { fs.unlinkSync(pidFile); } catch {}
          }
        }
      } catch (err) {}
    }

    // 2. 检查端口占用（检测手动启动的服务）
    const port = this.getProjectPort(projectId);
    if (port) {
      const isRunning = await this.isPortInUse(port);
      if (isRunning) {
        const processInfo = await this.getPortProcessInfo(port);
        if (processInfo && !seenPids.has(processInfo.pid)) {
          services.push({
            taskId: `manual-${port}`,
            pid: processInfo.pid,
            status: 'running',
            source: 'port_detection',
            port: port,
            command: processInfo.command
          });
        }
      }
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

  async stopService(projectId, taskId) {
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    const projectPath = project ? project.path : path.join(config.projects_root, projectId);

    const manualPortMatch = String(taskId).match(/^manual-(\d+)$/);
    if (manualPortMatch) {
      const port = Number(manualPortMatch[1]);
      const processInfo = await this.getPortProcessInfo(port);
      if (!processInfo?.pid) {
        return { success: false, error: `端口 ${port} 未找到运行中的服务` };
      }
      try {
        process.kill(processInfo.pid, 'SIGTERM');
        return { success: true, message: `服务已停止 (PID: ${processInfo.pid}, port: ${port})` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    
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

  async stopAllServices(projectId) {
    const services = await this.getRunningServices(projectId);
    const results = [];
    
    for (const svc of services) {
      results.push(await this.stopService(projectId, svc.taskId));
    }
    
    return { stopped: results.length, results };
  }
}

const deployServiceManager = new DeployServiceManager();

module.exports = {
  deployServiceManager,
  getDeployServiceManager: () => deployServiceManager
};
