/**
 * Express 路由
 */
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { getConfig, saveConfig } = require('../config');
const { getTaskQueue } = require('../core/task-queue');
const { getAgentExecutor } = require('../core/agent-executor');
const { getProjectScanner } = require('../core/project-scanner');
const { getStateSync } = require('../core/state-sync');
const { getDeployServiceManager } = require('../services/deploy-manager');
const { getNLParser } = require('../services/nl-parser');
const { getNginxManager } = require('../services/nginx-manager');
const { getAIService } = require('../services/ai-service');
const { broadcast } = require('../websocket/broadcast');
const terminalBuffer = require('../websocket/terminal-buffer');

// 扫描项目目录
async function scanProjects() {
  const config = getConfig();
  const projects = [];
  try {
    const entries = await fs.readdir(config.projects_root, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'DevManager') {
        const projectPath = path.join(config.projects_root, entry.name);
        const hasPackageJson = await fs.access(path.join(projectPath, 'package.json')).then(() => true).catch(() => false);
        
        if (hasPackageJson) {
          projects.push({
            id: entry.name.toLowerCase(),
            name: entry.name,
            path: projectPath,
            detected: true
          });
        }
      }
    }
  } catch (err) {
    console.error('[扫描] 失败:', err.message);
  }
  return projects;
}

// 读取项目数据
async function readProjectData(projectConfig) {
  const { path: projectPath, key_files = {} } = projectConfig;
  const result = {
    project: projectConfig,
    data: { dev_state: null, user_backlog: null, status_md: null },
    error: null
  };

  try {
    const files = {
      dev_state: path.join(projectPath, key_files.dev_state || 'dev_state.json'),
      user_backlog: path.join(projectPath, key_files.user_backlog || 'user_backlog.json')
    };

    const defaults = {
      dev_state: { 
        project: { name: path.basename(projectPath) }, 
        feature_list: [], 
        current_context: {
          agent_task_id: null,
          task_name: '等待指令',
          start_time: null,
          last_error: null,
          trial_count: 0
        }, 
        changelog: [] 
      },
      user_backlog: { version: '1.0', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: [] }
    };

    for (const [key, filePath] of Object.entries(files)) {
      try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf-8');
        result.data[key] = JSON.parse(data);
      } catch {
        await fs.writeFile(filePath, JSON.stringify(defaults[key], null, 2));
        result.data[key] = defaults[key];
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

// 创建路由
function createRoutes() {
  const router = express.Router();
  const taskQueue = getTaskQueue();
  const agentExecutor = getAgentExecutor();
  const projectScanner = getProjectScanner();
  const stateSync = getStateSync();
  const deployServiceManager = getDeployServiceManager();
  const nlParser = getNLParser();

  // 健康检查
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      version: '2.1',
      app: getConfig().app,
      queue: taskQueue.getStatus(),
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
    
    const merged = [...monitored];
    for (const p of projects) {
      if (!merged.find(m => m.id === p.id)) {
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

    const queueStatus = taskQueue.getStatus(projectId);
    
    // 同步 feature_list 和队列状态
    const featureList = [...(devState.feature_list || [])];
    const inProgressTask = queueStatus.in_progress;
    
    if (inProgressTask && inProgressTask.feature_id) {
      // 如果有正在执行的任务，确保 feature_list 中对应项的状态是 In_Progress
      const featureIndex = featureList.findIndex(f => f.id === inProgressTask.feature_id);
      if (featureIndex !== -1) {
        if (featureList[featureIndex].status !== 'In_Progress') {
          console.log(`[API] 同步状态: ${projectId}/${inProgressTask.feature_id} ${featureList[featureIndex].status} -> In_Progress`);
          featureList[featureIndex].status = 'In_Progress';
        }
      }
    }
    
    // 清理已完成的 feature_list 中错误的 In_Progress 状态
    featureList.forEach(f => {
      if (f.status === 'In_Progress' && (!inProgressTask || inProgressTask.feature_id !== f.id)) {
        // 检查队列的 completed 中是否有这个任务
        const completedTask = queueStatus.queue?.completed?.find(t => t.feature_id === f.id);
        if (completedTask) {
          console.log(`[API] 同步状态: ${projectId}/${f.id} In_Progress -> Completed (已完成)`);
          f.status = 'Completed';
        }
      }
    });
    
    if (queueStatus.queue && queueStatus.queue.completed) {
      queueStatus.queue.completed = queueStatus.queue.completed.map(t => ({
        id: t.id,
        feature_id: t.feature_id,
        feature_name: t.feature_name,
        status: t.status,
        created_at: t.created_at,
        started_at: t.started_at,
        completed_at: t.completed_at,
        error_count: t.error_count,
        last_error: t.last_error,
        logs: (t.logs || []).slice(-5).map(l => ({
          time: l.time,
          type: l.type,
          message: l.message?.substring(0, 100)
        }))
      }));
    }

    const deployServices = deployServiceManager.getRunningServices(projectId);

    res.json({
      project: { id: project.id, name: project.name, description: project.description, tech_stack: project.tech_stack },
      feature_list: featureList,
      current_context: devState.current_context || {},
      changelog: devState.changelog || [],
      backlog_items: backlog.items || [],
      queue: queueStatus,
      deploy_services: deployServices
    });
  });

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
      // 添加到 user_backlog.json
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
      await fs.writeFile(backlogPath, JSON.stringify(backlog, null, 2));

      // 同时添加到 dev_state.json 的 feature_list
      const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
      let devState = { feature_list: [], changelog: [] };
      try {
        const devData = await fs.readFile(devStatePath, 'utf-8');
        devState = JSON.parse(devData);
      } catch {}
      
      devState.feature_list = devState.feature_list || [];
      const newId = `F${String(devState.feature_list.length + 1).padStart(3, '0')}`;
      
      const newFeature = {
        id: newId,
        name: title.trim(),
        description: description?.trim() || '',
        status: auto_start ? 'In_Progress' : 'Pending',
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
      
      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      
      // 如果需要自动开始，添加到任务队列
      let task = null;
      if (auto_start) {
        task = await taskQueue.addTask(projectId, newId, newFeature);
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

  // 任务队列 API
  router.get('/queue', (req, res) => {
    res.json(taskQueue.getStatus());
  });

  router.get('/queue/:projectId', (req, res) => {
    res.json(taskQueue.getStatus(req.params.projectId));
  });

  router.post('/queue/claim', async (req, res) => {
    const { project_id, agent_id, agent_name } = req.body;
    
    if (project_id) {
      const result = await taskQueue.claimTask(project_id, { agent_id, agent_name });
      res.json(result);
    } else {
      const result = await taskQueue.claimAnyTask({ agent_id, agent_name });
      res.json(result);
    }
  });

  router.post('/queue/complete', async (req, res) => {
    const { project_id, result, files_changed } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }
    
    const completion = await taskQueue.completeTask(project_id, {
      message: result,
      files_changed: files_changed || [],
      completed_at: new Date().toISOString()
    });
    res.json(completion);
  });

  router.post('/queue/error', async (req, res) => {
    const { project_id, error, retry } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }
    
    const result = await taskQueue.reportError(project_id, error, retry);
    res.json(result);
  });

  router.post('/queue/log', async (req, res) => {
    const { project_id, type, message, data } = req.body;
    
    if (!project_id || !type || !message) {
      return res.status(400).json({ error: 'project_id、type和message不能为空' });
    }

    const result = await taskQueue.addLog(project_id, type, message, data);
    res.json(result);
  });

  router.get('/queue/logs/:projectId', async (req, res) => {
    const logs = taskQueue.getCurrentLogs(req.params.projectId);
    res.json(logs);
  });

  // ========== 暂停控制 API ==========
  
  // 获取暂停状态
  router.get('/queue/pause', (req, res) => {
    res.json({ paused: taskQueue.isPaused() });
  });
  
  // 设置暂停状态
  router.post('/queue/pause', async (req, res) => {
    const { paused } = req.body;
    if (typeof paused !== 'boolean') {
      return res.status(400).json({ error: 'paused 必须是布尔值' });
    }
    const result = await taskQueue.setPaused(paused);
    res.json(result);
  });
  
  // 切换暂停状态
  router.post('/queue/pause/toggle', async (req, res) => {
    const newState = !taskQueue.isPaused();
    const result = await taskQueue.setPaused(newState);
    res.json(result);
  });
  
  // 停止指定项目的当前任务
  router.post('/queue/:projectId/stop', async (req, res) => {
    const { projectId } = req.params;
    const { reason } = req.body || {};
    
    const result = await taskQueue.stopTask(projectId, reason || '用户手动停止');
    
    if (result.error) {
      return res.status(404).json(result);
    }
    
    res.json({
      success: true,
      message: '任务已停止',
      task: result.task
    });
  });
  
  // 停止所有正在执行的任务
  router.post('/queue/stop-all', async (req, res) => {
    const { reason } = req.body || {};
    
    const result = await taskQueue.stopAllTasks(reason || '用户手动停止所有任务');
    
    res.json({
      success: true,
      message: `已停止 ${result.stopped} 个任务`,
      results: result.results
    });
  });

  // 终端缓冲区 API
  router.get('/terminal/:projectId', (req, res) => {
    const { projectId } = req.params;
    const offset = parseInt(req.query.offset || '0', 10);
    
    const { data, offset: newOffset } = terminalBuffer.getBuffer(projectId, offset);
    const session = terminalBuffer.getSession(projectId);
    
    res.json({
      project_id: projectId,
      data: data,
      offset: newOffset,
      active: terminalBuffer.isActive(projectId),
      task_id: session?.taskId || null
    });
  });

  router.post('/terminal/:projectId/input', express.text({ type: '*/*' }), (req, res) => {
    const { projectId } = req.params;
    const input = req.body;
    
    const process = agentExecutor.processes[projectId];
    if (process && process.write) {
      process.write(input);
      res.json({ success: true });
    } else {
      res.status(409).json({ error: '没有正在运行的终端会话' });
    }
  });

  // Agent 获取下一个任务
  router.get('/agent/next-task', async (req, res) => {
    const config = getConfig();
    const status = taskQueue.getStatus();
    
    const pendingTask = status.queue.pending.find(t => !status.queue.in_progress[t.project_id]);
    
    if (pendingTask) {
      res.json({
        has_task: true,
        task: pendingTask,
        instruction: `请执行任务: ${pendingTask.feature_name}`,
        context: {
          project_path: config.monitored_projects.find(p => p.id === pendingTask.project_id)?.path,
          feature_details: pendingTask
        }
      });
    } else if (status.pending_count > 0) {
      res.json({
        has_task: false,
        pending_count: status.pending_count,
        message: '有等待中的任务，但所有项目都已有任务在执行中',
        claim_endpoint: '/api/queue/claim'
      });
    } else {
      res.json({
        has_task: false,
        pending_count: 0,
        message: '当前没有待处理的任务'
      });
    }
  });

  // 部署服务管理 API
  router.get('/deploy/:projectId/services', (req, res) => {
    const { projectId } = req.params;
    const services = deployServiceManager.getRunningServices(projectId);
    res.json({ project_id: projectId, services, count: services.length });
  });

  router.post('/deploy/:projectId/services/:taskId/stop', (req, res) => {
    const { projectId, taskId } = req.params;
    const result = deployServiceManager.stopService(projectId, taskId);
    res.json(result);
  });

  router.post('/deploy/:projectId/services/stop-all', (req, res) => {
    const { projectId } = req.params;
    const result = deployServiceManager.stopAllServices(projectId);
    res.json(result);
  });

  // 控制 API
  router.post('/executor/trigger', async (req, res) => {
    const { project_id } = req.body;
    console.log(`[API] 手动触发任务执行: ${project_id || '任意项目'}`);
    agentExecutor.tryExecute(project_id);
    res.json({ success: true, message: '已触发任务执行' });
  });

  router.post('/executor/stop', async (req, res) => {
    const { project_id } = req.body;
    console.log(`[API] 停止执行: ${project_id || '所有项目'}`);
    
    if (project_id) {
      agentExecutor.stop(project_id);
    } else {
      for (const pid of agentExecutor.executingProjects) {
        agentExecutor.stop(pid);
      }
    }
    
    res.json({ success: true, message: '已停止执行' });
  });

  router.post('/queue/reset', async (req, res) => {
    const { project_id, reason = '手动重置' } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: 'project_id 不能为空' });
    }
    
    await taskQueue.resetProjectTask(project_id, reason);
    res.json({ success: true, message: '任务已重置' });
  });

  // 状态同步 API
  router.post('/sync/:projectId', async (req, res) => {
    try {
      await stateSync.syncProjectState(req.params.projectId);
      res.json({ success: true, message: '状态已同步' });
    } catch (err) {
      res.status(500).json({ error: '同步失败', message: err.message });
    }
  });

  // 项目扫描 API
  router.post('/scan', async (req, res) => {
    const { auto_scan, interval } = req.body || {};
    
    try {
      const results = await projectScanner.scan();
      
      if (typeof auto_scan !== 'undefined') {
        if (auto_scan) {
          projectScanner.startAutoScan(interval || 5);
        } else {
          projectScanner.stopAutoScan();
        }
      }
      
      res.json({
        success: true,
        results,
        auto_scan: projectScanner.getStatus().auto_scan
      });
    } catch (err) {
      res.status(500).json({ error: '扫描失败', message: err.message });
    }
  });

  router.get('/scan/status', (req, res) => {
    res.json(projectScanner.getStatus());
  });

  router.post('/scan/settings', async (req, res) => {
    const { auto_scan, interval = 5 } = req.body;
    
    try {
      if (auto_scan) {
        projectScanner.startAutoScan(interval);
      } else {
        projectScanner.stopAutoScan();
      }
      
      const config = getConfig();
      config.scan_settings = {
        auto_scan: !!auto_scan,
        interval: interval,
        updated_at: new Date().toISOString()
      };
      await saveConfig();
      
      res.json({
        success: true,
        settings: config.scan_settings,
        status: projectScanner.getStatus()
      });
    } catch (err) {
      res.status(500).json({ error: '设置失败', message: err.message });
    }
  });

  // NLP API
  router.post('/nlp/parse', async (req, res) => {
    const { input, project_id } = req.body;
    
    if (!input) {
      return res.status(400).json({ error: '输入不能为空' });
    }

    try {
      const parsed = await nlParser.parse(input, { projectId: project_id });
      res.json({
        success: true,
        input,
        parsed,
        suggested_actions: [
          {
            action: parsed.operation,
            description: parsed.operation === 'create' ? '创建新需求' : 
                        parsed.operation === 'update' ? '更新现有需求' : 
                        parsed.operation === 'delete' ? '删除需求' : '查询需求'
          }
        ]
      });
    } catch (err) {
      res.status(500).json({ error: '解析失败', message: err.message });
    }
  });

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

      const newId = `F${String((devState.feature_list?.length || 0) + 1).padStart(3, '0')}`;
      
      const newFeature = {
        id: newId,
        name: parsed.title,
        description: parsed.description,
        status: auto_execute ? 'In_Progress' : 'Pending',
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

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));

      let task = null;
      if (auto_execute) {
        task = await taskQueue.addTask(project_id, newId, newFeature);
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

  // 点击卡片触发开发
  router.post('/projects/:projectId/features/:featureId/start', async (req, res) => {
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

      const feature = devState.feature_list?.find(f => f.id === featureId);
      if (!feature) {
        return res.status(404).json({ error: '功能项不存在' });
      }

      const task = await taskQueue.addTask(projectId, featureId, feature);

      res.json({
        success: true,
        message: '任务已加入开发队列，正在自动执行',
        task,
        next_step: 'Agent自动执行中...'
      });

    } catch (err) {
      res.status(500).json({ error: '启动任务失败', message: err.message });
    }
  });

  // 批量创建功能任务（AI解析结果）
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
      const startId = devState.feature_list.length + 1;
      
      const createdFeatures = [];
      
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const newId = `F${String(startId + i).padStart(3, '0')}`;
        
        const newFeature = {
          id: newId,
          name: task.title,
          description: task.description || '',
          status: (auto_start && i === 0) ? 'In_Progress' : 'Pending',
          category: task.category || 'Feature',
          created_from_ai: true,
          ai_input: req.body.input || '',
          created_at: new Date().toISOString()
        };
        
        devState.feature_list.push(newFeature);
        createdFeatures.push(newFeature);
        
        // 如果是第一个任务且需要自动开始
        if (auto_start && i === 0) {
          await taskQueue.addTask(projectId, newId, newFeature);
        }
      }
      
      // 添加变更日志
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

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      
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

      const inProgress = taskQueue.getProjectInProgress(projectId);
      if (inProgress && inProgress.feature_id === featureId) {
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

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      
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
    const { status } = req.body;
    
    if (!['Pending', 'In_Progress', 'Completed'].includes(status)) {
      return res.status(400).json({ error: '无效的状态，必须是 Pending/In_Progress/Completed' });
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

      const oldStatus = feature.status;
      feature.status = status;
      feature.updated_at = new Date().toISOString();

      devState.changelog = devState.changelog || [];
      devState.changelog.unshift({
        timestamp: new Date().toISOString(),
        type: 'status_change',
        message: `任务状态变更: ${feature.name}`,
        details: `${oldStatus || 'Pending'} → ${status}`
      });
      
      if (devState.changelog.length > 50) {
        devState.changelog = devState.changelog.slice(0, 50);
      }

      await fs.writeFile(devStatePath, JSON.stringify(devState, null, 2));
      
      broadcast('feature_updated', { 
        project_id: projectId, 
        feature_id: featureId, 
        changes: { status } 
      });

      res.json({
        success: true,
        message: '状态已更新',
        feature: { id: featureId, old_status: oldStatus, new_status: status }
      });

    } catch (err) {
      res.status(500).json({ error: '更新状态失败', message: err.message });
    }
  });

  // ==================== Nginx 部署管理 API ====================
  
  const nginxManager = getNginxManager();
  const aiService = getAIService();

  // ==================== AI 解析 API ====================
  
  // 测试AI连接
  router.post('/ai/test-connection', async (req, res) => {
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
  router.post('/ai/parse-requirement', async (req, res) => {
    const { input, project_id, settings } = req.body;
    
    if (!input || !input.trim()) {
      return res.status(400).json({ error: '需求描述不能为空' });
    }
    
    if (!settings || !settings.apiKey) {
      return res.status(400).json({ error: 'API Key未配置' });
    }

    try {
      // 获取项目上下文
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === project_id);
      
      let projectContext = {
        projectName: project?.name || project_id,
        techStack: project?.tech_stack || []
      };
      
      // 读取项目状态获取功能列表
      if (project) {
        try {
          const devStatePath = path.join(project.path, project.key_files?.dev_state || 'dev_state.json');
          const data = await fs.readFile(devStatePath, 'utf-8');
          const devState = JSON.parse(data);
          const features = devState.feature_list || [];
          
          projectContext.completedFeatures = features.filter(f => f.status === 'Completed');
          projectContext.inProgressFeatures = features.filter(f => f.status === 'In_Progress');
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
  
  // 获取 Nginx 管理状态
  router.get('/nginx/status', async (req, res) => {
    const status = await nginxManager.getStatus();
    res.json(status);
  });
  
  // 获取所有项目的部署配置
  router.get('/nginx/deploy-configs', (req, res) => {
    const configs = nginxManager.getAllDeployConfigs();
    res.json({
      count: configs.length,
      configs: configs
    });
  });
  
  // 获取单个项目的部署配置
  router.get('/nginx/deploy-configs/:projectId', (req, res) => {
    const { projectId } = req.params;
    const config = nginxManager.getDeployConfig(projectId);
    
    if (!config) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }
    
    res.json(config);
  });
  
  // 更新项目部署配置
  router.patch('/nginx/deploy-configs/:projectId', async (req, res) => {
    const { projectId } = req.params;
    const updates = req.body;
    
    const result = await nginxManager.updateDeployConfig(projectId, updates);
    
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    
    // 重新生成 Nginx 配置
    await nginxManager.saveNginxConfig();
    
    res.json({
      success: true,
      message: '部署配置已更新，请重载 Nginx 生效',
      config: result.config
    });
  });
  
  // 生成并保存 Nginx 配置
  router.post('/nginx/generate-config', async (req, res) => {
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
  
  // 验证 Nginx 配置
  router.post('/nginx/validate', async (req, res) => {
    const valid = await nginxManager.validateConfig();
    
    res.json({
      valid: valid,
      status: nginxManager.configStatus
    });
  });
  
  // 重载 Nginx 服务
  router.post('/nginx/reload', async (req, res) => {
    const result = await nginxManager.reloadNginx();
    
    if (!result.success) {
      return res.status(500).json(result);
    }
    
    res.json(result);
  });
  
  // 获取项目的启动命令
  router.get('/nginx/start-command/:projectId', (req, res) => {
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
  
  // 一键应用所有配置（生成+验证+重载）
  router.post('/nginx/apply', async (req, res) => {
    try {
      // 1. 生成配置
      const saveResult = await nginxManager.saveNginxConfig();
      if (!saveResult.success) {
        return res.status(500).json({
          success: false,
          step: 'generate',
          error: saveResult.error
        });
      }
      
      // 2. 验证配置
      const valid = await nginxManager.validateConfig();
      if (!valid) {
        return res.status(500).json({
          success: false,
          step: 'validate',
          error: 'Nginx 配置验证失败',
          status: nginxManager.configStatus
        });
      }
      
      // 3. 重载服务
      const reloadResult = await nginxManager.reloadNginx();
      if (!reloadResult.success) {
        return res.status(500).json({
          success: false,
          step: 'reload',
          error: reloadResult.error
        });
      }
      
      res.json({
        success: true,
        message: 'Nginx 配置已应用并生效',
        config_path: saveResult.path,
        projects: nginxManager.getAllDeployConfigs().length
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });

  // ==================== 项目部署控制 API ====================
  
  const runningProjects = new Map(); // projectId -> {pid, startTime, port}
  
  // 检查项目是否正在运行
  router.get('/deploy/:projectId/status', async (req, res) => {
    const { projectId } = req.params;
    const deployConfig = nginxManager.getDeployConfig(projectId);
    
    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }
    
    // 检查端口是否被占用
    const isRunning = await nginxManager.isPortInUse(deployConfig.port);
    
    res.json({
      project_id: projectId,
      port: deployConfig.port,
      running: isRunning,
      pid: runningProjects.get(projectId)?.pid || null,
      start_time: runningProjects.get(projectId)?.startTime || null
    });
  });
  
  // 启动项目
  router.post('/deploy/:projectId/start', async (req, res) => {
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
    
    // 如果指定了新端口，更新配置
    if (customPort && customPort !== deployConfig.port) {
      await nginxManager.updateDeployConfig(projectId, { port: customPort });
      await nginxManager.saveNginxConfig();
      deployConfig.port = customPort;
    }
    
    // 检查是否已在运行
    const isRunning = await nginxManager.isPortInUse(deployConfig.port);
    if (isRunning) {
      return res.json({
        success: true,
        message: '项目已在运行',
        port: deployConfig.port,
        already_running: true
      });
    }
    
    // 生成启动命令
    const startCmd = nginxManager.generateStartCommand(project, deployConfig);
    
    try {
      // 启动进程
      const child = spawn(startCmd.command, {
        cwd: startCmd.cwd,
        env: { ...process.env, ...startCmd.env },
        detached: true,
        stdio: 'ignore',
        shell: true
      });
      
      child.unref();
      
      runningProjects.set(projectId, {
        pid: child.pid,
        startTime: new Date().toISOString(),
        port: deployConfig.port
      });
      
      console.log(`[Deploy] 启动项目 ${projectId} PID: ${child.pid} 端口: ${deployConfig.port}`);
      
      res.json({
        success: true,
        message: '项目启动中',
        pid: child.pid,
        port: deployConfig.port,
        command: startCmd.command,
        cwd: startCmd.cwd
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  // 停止项目
  router.post('/deploy/:projectId/stop', async (req, res) => {
    const { projectId } = req.params;
    
    const deployConfig = nginxManager.getDeployConfig(projectId);
    if (!deployConfig) {
      return res.status(404).json({ error: '项目部署配置不存在' });
    }
    
    try {
      // 查找并杀死占用端口的进程
      const { stdout } = await execAsync(`lsof -t -i:${deployConfig.port}`);
      const pids = stdout.trim().split('\n');
      
      for (const pid of pids) {
        if (pid) {
          process.kill(parseInt(pid), 'SIGTERM');
          console.log(`[Deploy] 停止项目 ${projectId} PID: ${pid}`);
        }
      }
      
      runningProjects.delete(projectId);
      
      res.json({
        success: true,
        message: '项目已停止',
        killed_pids: pids
      });
    } catch (err) {
      res.json({
        success: true,
        message: '项目未运行或已停止'
      });
    }
  });
  
  // 更新项目端口并同步到代码
  router.post('/deploy/:projectId/update-port', async (req, res) => {
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
    
    // 1. 更新 DevManager 配置
    await nginxManager.updateDeployConfig(projectId, { port: newPort });
    await nginxManager.saveNginxConfig();
    
    // 2. 同步到项目代码
    const updatedFiles = [];
    
    if (deployConfig?.template === 'python') {
      // 更新 Python 文件中的端口
      const pyFiles = ['production_server.py', 'server.py', 'app.py'];
      for (const pyFile of pyFiles) {
        const pyPath = path.join(project.path, pyFile);
        try {
          let content = await fs.readFile(pyPath, 'utf-8');
          const originalContent = content;
          
          // 替换 ("0.0.0.0", PORT) 格式的端口
          content = content.replace(
            /\(\s*["']0\.0\.0\.0["']\s*,\s*\d+\s*\)/,
            `("0.0.0.0", ${newPort})`
          );
          
          // 替换 port = PORT 格式的端口
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
      // 更新 package.json scripts
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
  
  // 获取所有运行中的项目
  router.get('/deploy/running', async (req, res) => {
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
    
    res.json({
      count: running.length,
      projects: running
    });
  });

  // 挂载 Agent 直连路由
  router.use('/agent', require('./agent-direct'));

  return router;
}

module.exports = { createRoutes };
