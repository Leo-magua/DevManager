/**
 * DevManager v2.1 - 全自动开发指挥中心 (模块化版本)
 * 
 * 启动: node src/app.js
 * 访问: http://IP:81
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

// 加载配置
const { loadConfig, getConfig } = require('./config');

// 加载 WebSocket 模块
const { setupWebSocket } = require('./websocket/broadcast');

// 加载核心模块
const { getTaskQueue } = require('./core/task-queue');
const { getAgentExecutor } = require('./core/agent-executor');
const { getProjectScanner } = require('./core/project-scanner');
const { getStateSync } = require('./core/state-sync');

// 加载服务模块
const { getTaskMonitor } = require('./services/task-monitor');
const { getNginxManager } = require('./services/nginx-manager');

// 加载路由
const { createRoutes } = require('./routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 挂载 API 路由
app.use('/api', createRoutes());

// 启动函数
async function startup() {
  // 1. 加载配置
  await loadConfig();
  const config = getConfig();
  
  // 2. 初始化任务队列
  const taskQueue = getTaskQueue();
  await taskQueue.ensureQueueFile();
  
  // 3. 设置 WebSocket
  setupWebSocket(wss, () => taskQueue.getStatus());
  
  // 4. 获取其他模块实例
  const agentExecutor = getAgentExecutor();
  const projectScanner = getProjectScanner();
  const stateSync = getStateSync();
  const taskMonitor = getTaskMonitor();
  
  const PORT = config.app.port || 81;
  
  server.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log(`  ${config.app.name} v2.1 - 全自动开发指挥中心 (模块化)`);
    console.log('='.repeat(70));
    console.log(`  管理地址: http://localhost:${PORT}`);
    console.log(`  WebSocket: ws://localhost:${PORT}`);
    console.log('-'.repeat(70));
    console.log('  🚀 核心模块:');
    console.log('    - TaskQueue      任务队列系统');
    console.log('    - AgentExecutor  自动执行引擎');
    console.log('    - ProjectScanner 项目扫描器');
    console.log('    - StateSync      状态同步器');
    console.log('    - TaskMonitor    任务监控器');
    console.log('    - NLParser       自然语言解析');
    console.log('-'.repeat(70));
    console.log('  控制API:');
    console.log('    POST /api/executor/trigger      - 手动触发');
    console.log('    POST /api/executor/stop         - 停止执行');
    console.log('    POST /api/queue/reset           - 重置任务');
    console.log('    POST /api/sync/:projectId       - 同步状态');
    console.log('    POST /api/scan                  - 手动扫描项目');
    console.log('    GET  /api/scan/status           - 扫描状态');
    console.log('-'.repeat(70));
    console.log('  🌐 Nginx 部署管理:');
    console.log('    GET  /api/nginx/status          - Nginx 状态');
    console.log('    GET  /api/nginx/deploy-configs  - 部署配置列表');
    console.log('    POST /api/nginx/generate-config - 生成配置');
    console.log('    POST /api/nginx/apply           - 应用配置（生成+重载）');
    console.log('    GET  /api/nginx/start-command/:projectId - 获取启动命令');
    console.log('='.repeat(70));
    
    // 5. 启动时同步状态
    await stateSync.syncOnStartup();
    
    // 6. 启动监控器
    taskMonitor.start();
    
    // 7. 启动时执行一次项目扫描
    console.log('[Startup] 扫描项目目录...');
    await projectScanner.scan();
    
    // 8. 初始化 Nginx 管理器
    console.log('[Startup] 初始化 Nginx 部署管理...');
    const nginxManager = getNginxManager();
    await nginxManager.initialize();
    
    // 8. 如果配置了自动扫描，启动它
    if (config.scan_settings?.auto_scan) {
      projectScanner.startAutoScan(config.scan_settings.interval || 5);
    }
    
    // 9. 启动时检查所有有待处理任务的项目
    // 注意：只自动执行最近5分钟内添加的任务，避免重启后执行历史遗留任务
    setTimeout(() => {
      const startupTime = new Date();
      const CUTOFF_MINUTES = 5; // 5分钟内的任务才自动执行
      
      console.log('[Startup] 检查待处理任务...');
      const status = taskQueue.getStatus();
      const pendingProjects = [...new Set(status.queue.pending.map(t => t.project_id))];
      let autoStartCount = 0;
      
      for (const projectId of pendingProjects) {
        if (status.queue.in_progress[projectId]) continue;
        
        // 获取该项目的第一个待处理任务
        const task = status.queue.pending.find(t => t.project_id === projectId);
        if (!task) continue;
        
        // 检查任务创建时间是否在最近5分钟内
        const taskCreated = new Date(task.created_at);
        const minutesSinceCreation = (startupTime - taskCreated) / 1000 / 60;
        
        if (minutesSinceCreation <= CUTOFF_MINUTES) {
          console.log(`[Startup] 自动执行任务: ${projectId} - ${task.feature_name} (创建于 ${minutesSinceCreation.toFixed(1)} 分钟前)`);
          agentExecutor.tryExecute(projectId);
          autoStartCount++;
        } else {
          console.log(`[Startup] 跳过历史任务: ${projectId} - ${task.feature_name} (创建于 ${minutesSinceCreation.toFixed(1)} 分钟前，超过 ${CUTOFF_MINUTES} 分钟)`);
        }
      }
      
      if (autoStartCount === 0) {
        console.log('[Startup] 没有新任务需要自动执行');
      }
    }, 3000);
  });
}

// 启动应用
startup().catch(err => {
  console.error('[Startup] 启动失败:', err);
  process.exit(1);
});
