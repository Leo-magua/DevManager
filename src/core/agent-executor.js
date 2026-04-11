/**
 * Agent 自动执行引擎 (支持多项目并行)
 */
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const pty = require('node-pty');
const { getConfig } = require('../config');
const { getTaskQueue } = require('./task-queue');
const { broadcast, broadcastTerminal } = require('../websocket/broadcast');
const terminalBuffer = require('../websocket/terminal-buffer');

const EXECUTOR_LOG_PATH = path.join(__dirname, '../..', 'data', 'executor.log');

class AgentExecutor {
  constructor() {
    this.executingProjects = new Set();
    this.processes = {};
    this.stoppedProjects = new Set(); // 记录被手动停止的项目
  }

  async tryExecute(projectId = null) {
    const taskQueue = getTaskQueue();
    
    // 检查全局暂停状态
    if (taskQueue.isPaused()) {
      console.log(`[AgentExecutor] 全局暂停中，跳过任务执行`);
      return;
    }
    
    // 如果指定了项目且被手动停止过，跳过并清除标记
    if (projectId && this.stoppedProjects.has(projectId)) {
      console.log(`[AgentExecutor] ${projectId} 被手动停止，跳过自动执行`);
      this.stoppedProjects.delete(projectId); // 清除标记，允许下次手动启动
      return;
    }
    
    if (!projectId) {
      const config = getConfig();
      
      for (const project of config.monitored_projects) {
        if (!project.active) continue;
        if (this.executingProjects.has(project.id)) continue;
        
        const st = await taskQueue.getStatus(project.id);
        const executing = taskQueue.getExecutingTask(project.id);
        
        if (st.queued_count > 0 && !executing) {
          projectId = project.id;
          break;
        }
      }
      
      if (!projectId) return;
    }

    if (this.executingProjects.has(projectId)) {
      console.log(`[AgentExecutor] ${projectId} 已有任务在执行中，跳过`);
      return;
    }

    const status = await taskQueue.getStatus(projectId);
    
    if (status.executing) {
      console.log(`[AgentExecutor] ${projectId} 有任务正在执行: ${status.executing.feature_name}`);
      return;
    }

    if (!status.queued_count || status.queued_count === 0) {
      console.log(`[AgentExecutor] ${projectId} 开发队列为空，无任务可执行`);
      return;
    }

    const claimResult = await taskQueue.claimTask(projectId, {
      agent_id: 'auto-agent',
      agent_name: 'Auto Agent Executor'
    });

    if (claimResult.error) {
      console.error(`[AgentExecutor] ${projectId} 认领任务失败:`, claimResult.error);
      return;
    }

    const task = claimResult.task;
    console.log(`[AgentExecutor] ${projectId} 开始执行任务: ${task.feature_name}`);
    
    this.executeTask(projectId, task);
  }

  async executeTask(projectId, task) {
    const taskQueue = getTaskQueue();
    this.executingProjects.add(projectId);
    
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) {
      await taskQueue.reportError(projectId, '项目配置不存在');
      this.executingProjects.delete(projectId);
      return;
    }

    try {
      const prompt = this.generatePrompt(task, project);
      
      await taskQueue.addChangelog(projectId, 'system', `开始开发任务: ${task.feature_name}`);

      const result = await this.runKimiAgent(projectId, prompt, project.path, task);
      
      if (result.success) {
        await taskQueue.completeTask(projectId, {
          message: result.message || '开发完成',
          files_changed: result.files_changed || []
        });
      } else {
        const retryResult = await taskQueue.reportError(projectId, result.error || '执行失败', result.retry);
        // 如果是重试模式，重新入队而不是卡屏在 In_Progress
        if (retryResult && retryResult.status === 'retry') {
          await taskQueue.requeueForRetry(projectId);
        }
      }
    } catch (err) {
      console.error(`[AgentExecutor] ${projectId} 执行异常:`, err);
      await taskQueue.reportError(projectId, `执行异常: ${err.message}`, true);
    } finally {
      this.executingProjects.delete(projectId);
      delete this.processes[projectId];
      
      // 只有未被手动停止时才继续执行下一个任务
      if (!this.stoppedProjects.has(projectId)) {
        setTimeout(() => this.tryExecute(projectId), 2000);
      } else {
        console.log(`[AgentExecutor] ${projectId} 被标记为停止，不继续执行下一个任务`);
      }
    }
  }

  isDeployTask(task) {
    const keywords = ['部署', '启动', '端口', 'port', 'preview', 'serve', 'server', 'daemon'];
    const text = `${task.feature_name} ${task.feature_desc || ''}`.toLowerCase();
    return keywords.some(kw => text.includes(kw.toLowerCase()));
  }

  generatePrompt(task, project) {
    const config = getConfig();
    const isDeploy = this.isDeployTask(task);
    const currentPort = config.app.port || 81;
    
    if (isDeploy) {
      return `你正在执行一个【部署/服务启动】任务。请根据以下信息完成：

═══════════════════════════════════════════════════════════════
⚠️  【环境隔离声明】⚠️
═══════════════════════════════════════════════════════════════
当前管理界面端口: ${currentPort} (DevManager - 绝对不要动这个!)
目标部署项目: ${project.name}
目标部署路径: ${project.path}
目标部署端口: 见任务描述中的端口要求
═══════════════════════════════════════════════════════════════

【项目】${project.name}
【路径】${project.path}
【技术栈】${project.tech_stack?.join(', ') || '未知'}

【任务】${task.feature_name}
【描述】${task.feature_desc || '无详细描述'}

【关键要求 - 必须严格遵守】
1. 【目录确认】执行前先打印当前工作目录确认: pwd && ls -la
2. 检查项目结构，确定启动方式（npm run dev / npm run preview / npx vite / node server.js 等）
3. 【严禁】不要在 ${currentPort} 端口部署，这是 DevManager 的管理界面端口！
4. 修改配置确保端口正确（如需要）
5. 【必须】使用 nohup 或后台方式启动服务，确保命令不阻塞
   ✗ 错误: npm run dev  （会阻塞）
   ✓ 正确: nohup npm run dev > app.log 2>&1 &
   ✓ 或: (npm run preview -- --port 8080 &) 
6. 等待 3-5 秒让服务启动
7. 使用 curl 测试服务是否可访问
8. 【验证】确认服务不在 ${currentPort} 端口运行 (netstat -tlnp | grep ':${currentPort}')
9. 记录进程 PID 到 .devmanager/pids/<task_id>.pid 文件
10. 报告实际可访问的 URL

【禁止事项】
- 严禁修改或停止端口 ${currentPort} 的服务 (DevManager)
- 严禁在错误的目录执行部署
- 严禁阻塞式启动服务

【重要】任务完成后服务必须仍在后台运行！不要手动终止进程。

请开始部署。`;
    }

    return `你正在开发一个功能。请根据以下信息完成任务：

【项目】${project.name}
【路径】${project.path}
【技术栈】${project.tech_stack?.join(', ') || '未知'}

【任务】${task.feature_name}
【描述】${task.feature_desc || '无详细描述'}
【类别】${task.category}

请按以下步骤执行：
1. 先读取项目结构和现有代码
2. 分析需要实现的功能
3. 编写/修改代码实现功能
4. 测试确保功能正常
5. 完成后报告结果

注意：
- 保持代码风格一致
- 添加必要的注释
- 确保不破坏现有功能
- 如果有依赖需要先安装

请开始开发。`;
  }

  async runKimiAgent(projectId, prompt, projectPath, task) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const promptFile = path.join(__dirname, '../..', 'data', `prompt-${task.id}.txt`);
      fs.writeFileSync(promptFile, prompt);
      
      const kimiCmd = process.env.KIMI_CMD || 'kimi';
      const shell = process.env.SHELL || 'bash';
      
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          KIMI_TIMEOUT: '1800'
        }
      });
      
      this.processes[projectId] = ptyProcess;
      terminalBuffer.init(projectId, task.id);
      
      ptyProcess.write(`${kimiCmd} -y --no-thinking -p ${promptFile}\r`);
      
      ptyProcess.onData(async (data) => {
        terminalBuffer.append(projectId, data);
        broadcastTerminal(projectId, data);
        
        // 记录到本地日志文件
        fs.appendFileSync(EXECUTOR_LOG_PATH, data);
      });
      
      ptyProcess.onExit(async ({ exitCode }) => {
        try { fs.unlinkSync(promptFile); } catch {}
        terminalBuffer.close(projectId);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        broadcast('terminal_exit', {
          project_id: projectId,
          task_id: task.id,
          code: exitCode,
          duration: duration
        });
        
        if (exitCode === 0) {
          resolve({
            success: true,
            message: `开发完成 (耗时${duration}秒)`,
            files_changed: []
          });
        } else {
          resolve({
            success: false,
            error: `进程退出码: ${exitCode}`,
            retry: true
          });
        }
      });
      
      setTimeout(() => {
        if (this.processes[projectId]) {
          console.log(`[AgentExecutor] ${projectId} 任务执行超时，强制终止`);
          this.processes[projectId].kill('SIGTERM');
        }
      }, 25 * 60 * 1000);
    });
  }

  stop(projectId) {
    // 标记为手动停止，防止自动重启
    this.stoppedProjects.add(projectId);
    
    if (this.processes[projectId]) {
      try {
        const ptyProcess = this.processes[projectId];
        
        // 1. 先尝试 SIGINT（优雅终止）
        try {
          ptyProcess.kill('SIGINT');
        } catch (e) {}
        
        // 2. 延迟后如果还在，发送 SIGTERM
        setTimeout(() => {
          try {
            if (ptyProcess && !ptyProcess.killed) {
              ptyProcess.kill('SIGTERM');
            }
          } catch (e) {}
        }, 500);
        
        // 3. 再延迟后如果还在，强制 SIGKILL
        setTimeout(() => {
          try {
            if (ptyProcess && !ptyProcess.killed) {
              ptyProcess.kill('SIGKILL');
            }
          } catch (e) {}
        }, 2000);
        
        console.log(`[AgentExecutor] 已发送停止信号到 ${projectId}，已标记为手动停止`);
      } catch (e) {
        console.error(`[AgentExecutor] 停止 ${projectId} 失败:`, e.message);
      }
      delete this.processes[projectId];
    }
    this.executingProjects.delete(projectId);
  }
}

const agentExecutor = new AgentExecutor();

module.exports = {
  agentExecutor,
  getAgentExecutor: () => agentExecutor
};
