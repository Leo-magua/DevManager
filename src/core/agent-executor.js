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
const { shellManager } = require('../websocket/shell-manager');

const EXECUTOR_LOG_PATH = path.join(__dirname, '../..', 'data', 'executor.log');
const DEFAULT_TOOL_TYPE = 'kimi';

class AgentExecutor {
  constructor() {
    this.executingProjects = new Set();
    this.processes = {};
    this.stoppedProjects = new Set(); // 记录被手动停止的项目
    
    // 注册任务完成回调，用于自动执行下一个排队中的任务
    const taskQueue = getTaskQueue();
    taskQueue.setTaskCompletedHandler((projectId) => this._onTaskCompleted(projectId));
  }

  /**
   * 任务完成后的回调 - 尝试执行下一个排队中的任务
   */
  async _onTaskCompleted(projectId) {
    // 只做状态清除，不触发下一个任务
    // 推进下一个任务统一由 executeTask 的 finally 块负责，避免双重触发
    this.executingProjects.delete(projectId);
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
    const taskMonitor = require('../services/task-monitor').getTaskMonitor();
    // 新任务显式启动时，应清除历史手动停止标记，避免成功结束后仍走 stop 分支。
    this.stoppedProjects.delete(projectId);
    this.executingProjects.add(projectId);
    let isRequeue = false; // 标记任务是否重新入队（需要冷却后重试，而非立刻推进）
    
    // 记录任务开始时间，用于超时检测
    taskMonitor.recordTaskStart(projectId);
    
    const config = getConfig();
    const project = config.monitored_projects.find(p => p.id === projectId);
    if (!project) {
      await taskQueue.reportError(projectId, '项目配置不存在');
      this.executingProjects.delete(projectId);
      taskMonitor.clearTaskStart(projectId);
      return;
    }

    try {
      const toolType = task.toolType || task.tool_type || DEFAULT_TOOL_TYPE;
      const prompt = this.generatePrompt(task, project, toolType);
      
      await taskQueue.addChangelog(projectId, 'system', `开始开发任务: ${task.feature_name}`);

      const result = toolType === 'cursor'
        ? await this.runCursorAgent(projectId, prompt, project.path, task)
        : toolType === 'codex'
          ? await this.runCodexAgent(projectId, prompt, project.path, task)
          : await this.runKimiAgent(projectId, prompt, project.path, task);
      
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
          isRequeue = true; // 任务重新入队，需要冷却后重试
        }
      }
    } catch (err) {
      console.error(`[AgentExecutor] ${projectId} 执行异常:`, err);
      await taskQueue.reportError(projectId, `执行异常: ${err.message}`, true);
    } finally {
      this.executingProjects.delete(projectId);
      delete this.processes[projectId];
      
      // 清理任务开始时间记录
      const taskMonitor = require('../services/task-monitor').getTaskMonitor();
      taskMonitor.clearTaskStart(projectId);
      
      // 任务结束后恢复持久 shell（让用户可以继续交互）
      shellManager.resume(projectId);
      
      // 只有未被手动停止时才继续执行下一个任务
      if (!this.stoppedProjects.has(projectId)) {
        if (isRequeue) {
          // 重新入队的失败任务需要冷却30秒，避免立刻重试同一个任务
          console.log(`[AgentExecutor] ${projectId} 任务重新入队等待重试，30秒后尝试推进队列`);
          setTimeout(() => this.tryExecute(null), 30 * 1000);
        } else {
          // 正常完成或不重试的错误，2秒后推进下一个任务
          setTimeout(() => this.tryExecute(projectId), 2000);
        }
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

  generatePrompt(task, project, toolType = DEFAULT_TOOL_TYPE) {
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

    if (toolType === 'codex') {
      return `你正在当前项目目录内执行一个开发任务。

项目: ${project.name}
路径: ${project.path}
技术栈: ${project.tech_stack?.join(', ') || '未知'}

任务: ${task.feature_name}
描述: ${task.feature_desc || '无详细描述'}
类别: ${task.category}
任务ID: ${task.id}

要求:
- 先快速阅读项目结构和相关代码，再动手修改
- 仅实现与当前任务直接相关的改动，避免顺手大改
- 保持现有代码风格和项目约定
- 如有必要，运行最小充分的验证命令
- 完成后在输出中明确说明改了什么、验证了什么、是否有遗留风险

请直接开始处理这个任务。`;
    }

    if (toolType === 'cursor') {
      return `你正在当前项目目录内执行一个开发任务。

项目: ${project.name}
路径: ${project.path}
技术栈: ${project.tech_stack?.join(', ') || '未知'}

任务: ${task.feature_name}
描述: ${task.feature_desc || '无详细描述'}
类别: ${task.category}
任务ID: ${task.id}

请按这个顺序完成:
1. 阅读项目结构与相关实现
2. 修改代码完成任务
3. 运行必要验证
4. 输出简短结果总结

要求:
- 不要修改与任务无关的模块
- 保持现有风格
- 如果遇到阻塞，明确输出失败原因

请开始开发。`;
    }

    return `你正在开发一个功能。请根据以下信息完成任务：

【项目】${project.name}
【路径】${project.path}
【技术栈】${project.tech_stack?.join(', ') || '未知'}

【任务】${task.feature_name}
【描述】${task.feature_desc || '无详细描述'}
【类别】${task.category}
【任务ID】${task.id}

请按以下步骤执行：
1. 先读取项目结构和现有代码
2. 分析需要实现的功能
3. 编写/修改代码实现功能
4. 测试确保功能正常
5. 完成后报告结果

【重要 - 任务完成后必须执行】
任务完成后，请执行以下命令更新任务状态为已完成：
  curl -X POST "http://localhost:${getConfig().app.port || 81}/api/tasks/${task.id}/complete" \
    -H "Content-Type: application/json" \
    -d '{"message": "任务完成描述"}'

或者如果任务失败需要重试：
  curl -X POST "http://localhost:${getConfig().app.port || 81}/api/tasks/${task.id}/fail" \
    -H "Content-Type: application/json" \
    -d '{"error": "失败原因", "retry": true}'

注意：
- 保持代码风格一致
- 添加必要的注释
- 确保不破坏现有功能
- 如果有依赖需要先安装
- **最后一步必须调用API更新任务状态，否则系统会认为任务还在执行中**

请开始开发。`;
  }

  buildCursorCommand(promptFile, projectPath) {
    const escapedPromptFile = promptFile.replace(/"/g, '\\"');
    const escapedProjectPath = projectPath.replace(/"/g, '\\"');
    const cursorAgentBin = process.env.CURSOR_AGENT_BIN || '/root/.local/bin/cursor-agent';
    const defaultCursorModel = process.env.CURSOR_MODEL_DEFAULT || 'composer-2';

    return `
source /root/.cursor-openrouter.env 2>/dev/null || true
PROMPT_CONTENT=$(cat "${escapedPromptFile}")
MODEL="${defaultCursorModel}"
if [ -n "$MODEL" ]; then
  exec env \\
    OPENAI_API_KEY="$OPENROUTER_API_KEY" \\
    OPENAI_API_BASE_URL="$OPENAI_API_BASE_URL" \\
    OPENAI_API_TYPE="open_ai" \\
    https_proxy="$https_proxy" \\
    HTTPS_PROXY="$HTTPS_PROXY" \\
    "${cursorAgentBin}" -p --yolo --model "$MODEL" --workspace "${escapedProjectPath}" "$PROMPT_CONTENT"
else
  exec env \\
    OPENAI_API_KEY="$OPENROUTER_API_KEY" \\
    OPENAI_API_BASE_URL="$OPENAI_API_BASE_URL" \\
    OPENAI_API_TYPE="open_ai" \\
    https_proxy="$https_proxy" \\
    HTTPS_PROXY="$HTTPS_PROXY" \\
    "${cursorAgentBin}" -p --yolo --workspace "${escapedProjectPath}" "$PROMPT_CONTENT"
fi`.trim();
  }

  async runKimiAgent(projectId, prompt, projectPath, task) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let outputBuffer = '';
      let taskCompletedDetected = false;
      
      const promptFile = path.join(__dirname, '../..', 'data', `prompt-${task.id}.txt`);
      fs.writeFileSync(promptFile, prompt);
      
      const kimiCmd = process.env.KIMI_CMD || 'kimi';
      const shell = process.env.SHELL || 'bash';
      const shellArgs = shell.includes('bash') ? ['-lc', `${kimiCmd} -y --no-thinking -p "${promptFile}"`] : ['-c', `${kimiCmd} -y --no-thinking -p "${promptFile}"`];

      const ptyProcess = pty.spawn(shell, shellArgs, {
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
      // 暂停持久 shell 输出，避免与任务输出混淆
      shellManager.pause(projectId);
      
      terminalBuffer.init(projectId, task.id);
      
      // 任务完成检测关键词
      const successPatterns = [
        /修改完成|修改已成功|已成功修改/i,
        /任务已完成|任务完成|开发完成/i,
        /已完成.*移除|已成功.*删除/i,
        /总结.*修改|修改总结/i,
        /功能已实现|已实现.*功能/i,
        /代码已提交|已提交.*代码/i,
        /To resume this session/i
      ];
      
      ptyProcess.onData(async (data) => {
        terminalBuffer.append(projectId, data);
        broadcastTerminal(projectId, data);
        
        // 记录到本地日志文件
        fs.appendFileSync(EXECUTOR_LOG_PATH, data);
        
        // 收集输出用于检测任务完成
        outputBuffer += data;
        // 保持缓冲区大小合理（保留最后 10KB）
        if (outputBuffer.length > 10240) {
          outputBuffer = outputBuffer.slice(-10240);
        }
        
        // 检测任务是否已完成
        if (!taskCompletedDetected) {
          for (const pattern of successPatterns) {
            if (pattern.test(outputBuffer)) {
              taskCompletedDetected = true;
              console.log(`[AgentExecutor] ${projectId} 检测到任务完成标记`);
              break;
            }
          }
        }
      });
      
      ptyProcess.onExit(async ({ exitCode }) => {
        try { fs.unlinkSync(promptFile); } catch {}
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // 根据退出码/完成标记写入终端状态消息（切换项目后仍可回看历史）
        const isSuccess = exitCode === 0 || taskCompletedDetected;
        const exitIcon = isSuccess ? '\u2713' : '\u2717';
        const exitColor = isSuccess ? '\x1b[32m' : '\x1b[31m';
        const exitMsg = `\r\n${exitColor}[${exitIcon} 任务${isSuccess ? '完成' : '结束'} | 退出码: ${exitCode} | 耗时: ${duration}s]\x1b[0m\r\n`;
        terminalBuffer.append(projectId, exitMsg);
        terminalBuffer.close(projectId, exitCode);
        
        broadcast('terminal_exit', {
          project_id: projectId,
          task_id: task.id,
          code: exitCode,
          duration: duration,
          success: isSuccess,
          task_name: task.feature_name
        });
        
        // 判断任务成功的条件：
        // 1. exitCode === 0，或者
        // 2. 在输出中检测到任务完成标记
        if (isSuccess) {
          const successMessage = taskCompletedDetected 
            ? `开发完成 (检测到完成标记，耗时${duration}秒)`
            : `开发完成 (耗时${duration}秒)`;
          resolve({
            success: true,
            message: successMessage,
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


  async runCursorAgent(projectId, prompt, projectPath, task) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let outputBuffer = '';
      let taskCompletedDetected = false;
      let taskFailedDetected = false;

      const promptFile = path.join(__dirname, '../..', 'data', `prompt-${task.id}.txt`);
      fs.writeFileSync(promptFile, prompt);

      const shell = process.env.SHELL || 'bash';
      const cursorCommand = this.buildCursorCommand(promptFile, projectPath);
      const shellArgs = shell.includes('bash')
        ? ['-lc', cursorCommand]
        : ['-c', cursorCommand];

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1'
        }
      });

      this.processes[projectId] = ptyProcess;
      shellManager.pause(projectId);
      terminalBuffer.init(projectId, task.id);

      const successPatterns = [
        /修改完成|修改已成功|已成功修改/i,
        /任务已完成|任务完成|开发完成/i,
        /已完成.*移除|已成功.*删除/i,
        /总结.*修改|修改总结/i,
        /功能已实现|已实现.*功能/i,
        /代码已提交|已提交.*代码/i,
        /Task completed|Done[."|]|Finished[."|]/i,
        /To resume this session/i
      ];
      const failurePatterns = [
        /Cannot use this model/i,
        /Available models:/i,
        /error:/i,
        /\bfailed\b/i,
        /\bexception\b/i,
        /\bnot found\b/i,
        /\bpermission denied\b/i
      ];

      ptyProcess.onData(async (data) => {
        terminalBuffer.append(projectId, data);
        broadcastTerminal(projectId, data);
        fs.appendFileSync(EXECUTOR_LOG_PATH, data);

        outputBuffer += data;
        if (outputBuffer.length > 10240) {
          outputBuffer = outputBuffer.slice(-10240);
        }

        if (!taskFailedDetected) {
          for (const pattern of failurePatterns) {
            if (pattern.test(outputBuffer)) {
              taskFailedDetected = true;
              console.log(`[AgentExecutor] ${projectId} (cursor) 检测到任务失败标记`);
              break;
            }
          }
        }

        if (!taskCompletedDetected && !taskFailedDetected) {
          for (const pattern of successPatterns) {
            if (pattern.test(outputBuffer)) {
              taskCompletedDetected = true;
              console.log(`[AgentExecutor] ${projectId} (cursor) 检测到任务完成标记`);
              break;
            }
          }
        }
      });

      ptyProcess.onExit(async ({ exitCode }) => {
        try { fs.unlinkSync(promptFile); } catch {}

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const isSuccess = !taskFailedDetected && (exitCode === 0 || taskCompletedDetected);
        const exitIcon = isSuccess ? '✓' : '✗';
        const exitColor = isSuccess ? '[32m' : '[31m';
        const exitMsg = `
${exitColor}[${exitIcon} 任务${isSuccess ? '完成' : '结束'} | cursor | 退出码: ${exitCode} | 耗时: ${duration}s][0m
`;
        terminalBuffer.append(projectId, exitMsg);
        terminalBuffer.close(projectId, exitCode);

        broadcast('terminal_exit', {
          project_id: projectId,
          task_id: task.id,
          code: exitCode,
          duration: duration,
          success: isSuccess,
          task_name: task.feature_name
        });

        if (isSuccess) {
          const successMessage = taskCompletedDetected
            ? `开发完成 (cursor, 检测到完成标记，耗时${duration}秒)`
            : `开发完成 (cursor, 耗时${duration}秒)`;
          resolve({
            success: true,
            message: successMessage,
            files_changed: []
          });
        } else {
          resolve({
            success: false,
            error: taskFailedDetected ? 'cursor 输出包含失败标记' : `cursor 退出码: ${exitCode}`,
            retry: true
          });
        }
      });

      setTimeout(() => {
        if (this.processes[projectId]) {
          console.log(`[AgentExecutor] ${projectId} (cursor) 任务执行超时，强制终止`);
          this.processes[projectId].kill('SIGTERM');
        }
      }, 25 * 60 * 1000);
    });
  }

  async runCodexAgent(projectId, prompt, projectPath, task) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let outputBuffer = '';
      let taskCompletedDetected = false;
      let taskFailedDetected = false;

      const promptFile = path.join(__dirname, '../..', 'data', `prompt-${task.id}.txt`);
      fs.writeFileSync(promptFile, prompt);

      const codexCmd = process.env.CODEX_CMD || 'codex';
      const shell = process.env.SHELL || 'bash';
      const shellArgs = shell.includes('bash')
        ? ['-lc', `${codexCmd} exec --full-auto -C "${projectPath}" - < "${promptFile}"`]
        : ['-c', `${codexCmd} exec --full-auto -C "${projectPath}" - < "${promptFile}"`];

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: projectPath,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1'
        }
      });

      this.processes[projectId] = ptyProcess;
      shellManager.pause(projectId);
      terminalBuffer.init(projectId, task.id);

      const successPatterns = [
        /修改完成|修改已成功|已成功修改/i,
        /任务已完成|任务完成|开发完成/i,
        /已完成.*移除|已成功.*删除/i,
        /总结.*修改|修改总结/i,
        /功能已实现|已实现.*功能/i,
        /代码已提交|已提交.*代码/i,
        /All done/i,
        /Completed/i,
        /To resume this session/i
      ];
      const failurePatterns = [
        /error:/i,
        /\bfailed\b/i,
        /\bexception\b/i,
        /I did not call.*API/i,
        /没有调用任务完成\/失败 API/i,
        /not call(?:ed)? .*complete/i
      ];

      ptyProcess.onData(async (data) => {
        terminalBuffer.append(projectId, data);
        broadcastTerminal(projectId, data);
        fs.appendFileSync(EXECUTOR_LOG_PATH, data);

        outputBuffer += data;
        if (outputBuffer.length > 10240) {
          outputBuffer = outputBuffer.slice(-10240);
        }

        if (!taskFailedDetected) {
          for (const pattern of failurePatterns) {
            if (pattern.test(outputBuffer)) {
              taskFailedDetected = true;
              console.log(`[AgentExecutor] ${projectId} (codex) 检测到任务失败标记`);
              break;
            }
          }
        }

        if (!taskCompletedDetected && !taskFailedDetected) {
          for (const pattern of successPatterns) {
            if (pattern.test(outputBuffer)) {
              taskCompletedDetected = true;
              console.log(`[AgentExecutor] ${projectId} (codex) 检测到任务完成标记`);
              break;
            }
          }
        }
      });

      ptyProcess.onExit(async ({ exitCode }) => {
        try { fs.unlinkSync(promptFile); } catch {}

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const isSuccess = !taskFailedDetected && (exitCode === 0 || taskCompletedDetected);
        const exitIcon = isSuccess ? '✓' : '✗';
        const exitColor = isSuccess ? '\x1b[32m' : '\x1b[31m';
        const exitMsg = `\r\n${exitColor}[${exitIcon} 任务${isSuccess ? '完成' : '结束'} | codex | 退出码: ${exitCode} | 耗时: ${duration}s]\x1b[0m\r\n`;
        terminalBuffer.append(projectId, exitMsg);
        terminalBuffer.close(projectId, exitCode);

        broadcast('terminal_exit', {
          project_id: projectId,
          task_id: task.id,
          code: exitCode,
          duration: duration,
          success: isSuccess,
          task_name: task.feature_name
        });

        if (isSuccess) {
          const successMessage = taskCompletedDetected
            ? `开发完成 (codex, 检测到完成标记，耗时${duration}秒)`
            : `开发完成 (codex, 耗时${duration}秒)`;
          resolve({
            success: true,
            message: successMessage,
            files_changed: []
          });
        } else {
          resolve({
            success: false,
            error: taskFailedDetected ? 'codex 输出包含失败标记' : `codex 退出码: ${exitCode}`,
            retry: true
          });
        }
      });

      setTimeout(() => {
        if (this.processes[projectId]) {
          console.log(`[AgentExecutor] ${projectId} (codex) 任务执行超时，强制终止`);
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
