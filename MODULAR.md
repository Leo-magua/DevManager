# DevManager 模块化重构说明

## 目录结构

```
DevManager/
├── src/                      # 源代码目录
│   ├── app.js               # 应用入口
│   ├── config/              # 配置管理
│   │   └── index.js
│   ├── websocket/           # WebSocket 相关
│   │   ├── broadcast.js     # 广播功能
│   │   └── terminal-buffer.js
│   ├── core/                # 核心模块
│   │   ├── task-queue.js    # 任务队列系统
│   │   ├── agent-executor.js
│   │   ├── project-scanner.js
│   │   └── state-sync.js
│   ├── services/            # 业务服务
│   │   ├── deploy-manager.js
│   │   ├── task-monitor.js
│   │   └── nl-parser.js
│   └── routes/              # Express 路由
│       └── index.js
├── public/                   # 前端文件
├── data/                     # 数据文件
├── backups/                  # 备份文件
├── server.js                 # 旧版入口 (保留)
├── server-v2.js              # v2版入口 (保留)
└── package.json
```

## 启动方式

```bash
# 新版模块化入口 (推荐)
npm start
# 或
node src/app.js

# 旧版入口 (保留兼容)
npm run start:legacy    # server.js
npm run start:v2        # server-v2.js
```

## 模块说明

| 模块 | 职责 |
|------|------|
| config | 配置加载、保存、管理 |
| websocket/broadcast | WebSocket 连接管理、消息广播 |
| websocket/terminal-buffer | 终端输出缓冲区管理 |
| core/task-queue | 多项目任务队列系统 |
| core/agent-executor | Kimi Agent 自动执行引擎 |
| core/project-scanner | 项目自动扫描、初始化 |
| core/state-sync | 队列与项目状态同步 |
| services/deploy-manager | 部署服务 PID 管理 |
| services/task-monitor | 任务超时监控 |
| services/nl-parser | 自然语言需求解析 |
| routes | Express API 路由 |

## 原文件保留

- `server.js` - 基础版单文件 (408行)
- `server-v2.js` - v2完整版单文件 (2417行)

这两个文件保持原样，可随时切换回旧版本。
