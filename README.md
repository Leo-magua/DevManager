# AllProject DevManager

> 多项目开发管理中枢 - 统一管理多个项目的可视化看板

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📖 项目简介

**DevManager** 是一个专为多项目开发场景设计的可视化管理工具。它可以：

- 📁 **统一管理** 多个项目的开发状态
- 📊 **可视化看板** 展示任务进度（Pending → In Progress → Completed）
- 🤖 **监控 Agent 状态** 实时显示正在执行的任务和试错记录
- 📝 **需求管理** 集中收集和管理各项目的需求
- 🔄 **实时同步** 每10秒自动刷新数据

### 适用场景

- 一个人维护多个项目，需要统一查看状态
- 团队协作，需要跟踪各项目进度
- AI Agent 自动化开发，需要监控执行状态

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd /var/www/AllProject/DevManager
npm install
```

### 2. 启动服务

```bash
# 前台运行
node server.js

# 后台运行
nohup node server.js > server.log 2>&1 &
```

### 3. 访问看板

打开浏览器访问：

```
http://your-server-ip:81
```

---

## 📁 项目结构

```
DevManager/
├── server.js           # Express 后端服务
├── config.json         # 项目配置文件
├── package.json        # 依赖配置
├── server.log          # 运行日志
├── README.md           # 本文件
├── public/
│   └── index.html      # 前端看板页面
└── .kimi/
    └── status.md       # 项目状态追踪
```

---

## ⚙️ 配置说明

编辑 `config.json` 来管理你的项目：

```json
{
  "app": {
    "name": "AllProject DevManager",
    "version": "1.0.0",
    "port": 81,
    "description": "统一管理 AllProject 下所有子项目的开发看板"
  },
  "projects_root": "/var/www/AllProject",
  "monitored_projects": [
    {
      "id": "personalwork",
      "name": "PersonalWork",
      "path": "/var/www/AllProject/PersonalWork",
      "description": "个人项目作品管理工具",
      "tech_stack": ["React", "TypeScript", "Vite", "Tailwind"],
      "key_files": {
        "dev_state": "dev_state.json",
        "user_backlog": "user_backlog.json",
        "status": ".kimi/status.md",
        "requirements": "功能需求表.md"
      },
      "active": true
    }
  ],
  "features": {
    "auto_refresh": 10,
    "file_watcher": true,
    "multi_project": true
  }
}
```

### 配置字段说明

| 字段 | 类型 | 说明 |
|-----|------|------|
| `app.port` | number | 服务端口，默认81 |
| `projects_root` | string | 项目根目录路径 |
| `monitored_projects` | array | 监控的项目列表 |
| `monitored_projects[].id` | string | 项目唯一标识 |
| `monitored_projects[].path` | string | 项目绝对路径 |
| `monitored_projects[].key_files` | object | 关键文件映射 |
| `monitored_projects[].active` | boolean | 是否激活监控 |

---

## 🎯 核心功能

### 1. 项目切换

看板顶部有项目选择器，可以切换不同的项目查看其状态。

### 2. 功能看板

三列布局展示任务状态：
- 🟡 **待处理 (Pending)** - 待开始的任务
- 🔵 **进行中 (In Progress)** - 正在开发的任务
- 🟢 **已完成 (Completed)** - 已完成的任务

点击卡片可循环切换状态。

### 3. Agent 状态监控

实时显示：
- 当前执行的任务名称
- 任务ID
- 试错次数
- 错误信息（如果有）

### 4. 需求提交

在需求输入区填写：
- 需求标题（必填）
- 需求描述（可选）
- 优先级（高/中/低）
- 类别（功能/Bug/前端/后端/工具）

提交后会自动写入对应项目的 `user_backlog.json`。

### 5. 开发日志

按时间倒序展示项目的开发日志，包括：
- 系统事件
- 需求提交
- 状态变更
- 错误记录

---

## 🔌 API 接口

### 基础信息

| 端点 | 方法 | 说明 |
|-----|------|------|
| `GET /api/health` | GET | 健康检查 |
| `GET /api/config` | GET | 获取配置 |

### 项目管理

| 端点 | 方法 | 说明 |
|-----|------|------|
| `GET /api/projects` | GET | 获取所有项目列表 |
| `GET /api/projects/:id` | GET | 获取指定项目详情 |
| `POST /api/projects` | POST | 添加新项目 |

### 看板数据

| 端点 | 方法 | 说明 |
|-----|------|------|
| `GET /api/projects/:id/dashboard` | GET | 获取项目看板数据 |
| `POST /api/projects/:id/backlog` | POST | 提交新需求 |
| `PATCH /api/projects/:id/features/:fid` | PATCH | 更新任务状态 |

### 示例请求

```bash
# 获取项目看板数据
curl http://localhost:81/api/projects/personalwork/dashboard

# 提交新需求
curl -X POST http://localhost:81/api/projects/personalwork/backlog \
  -H "Content-Type: application/json" \
  -d '{"title": "新增功能", "description": "详细描述", "priority": "High"}'

# 更新任务状态
curl -X PATCH http://localhost:81/api/projects/personalwork/features/F001 \
  -H "Content-Type: application/json" \
  -d '{"status": "In_Progress"}'
```

---

## ➕ 如何添加新项目

### 方式一：修改配置文件

1. 编辑 `config.json`：

```json
{
  "monitored_projects": [
    {
      "id": "my-new-project",
      "name": "My New Project",
      "path": "/var/www/AllProject/MyNewProject",
      "description": "新项目描述",
      "tech_stack": ["Vue", "Node.js"],
      "key_files": {
        "dev_state": "dev_state.json",
        "user_backlog": "user_backlog.json",
        "status": ".kimi/status.md"
      },
      "active": true
    }
  ]
}
```

2. 重启服务：

```bash
pkill -f "node server.js"
nohup node server.js > server.log 2>&1 &
```

### 方式二：通过 API 添加

```bash
curl -X POST http://localhost:81/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-new-project",
    "name": "My New Project",
    "path": "/var/www/AllProject/MyNewProject",
    "description": "新项目描述",
    "tech_stack": ["Vue", "Node.js"]
  }'
```

---

## 📊 数据文件格式

### dev_state.json

```json
{
  "project": {
    "name": "项目名称",
    "current_stage": "开发阶段"
  },
  "feature_list": [
    {
      "id": "F001",
      "name": "功能名称",
      "status": "Pending",
      "priority": "High",
      "category": "后端"
    }
  ],
  "current_context": {
    "agent_task_id": null,
    "task_name": "等待指令",
    "trial_count": 0,
    "last_error": null
  },
  "changelog": [
    {
      "id": "LOG001",
      "timestamp": "2024-01-01T00:00:00Z",
      "type": "system",
      "message": "消息内容",
      "details": "详细描述"
    }
  ]
}
```

### user_backlog.json

```json
{
  "version": "1.0",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "items": [
    {
      "id": "REQ1234567890",
      "title": "需求标题",
      "description": "需求描述",
      "priority": "High",
      "category": "Feature",
      "status": "New",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## 🔧 常见问题

### Q: 如何修改端口号？

编辑 `config.json` 中的 `app.port`，然后重启服务。

### Q: 数据文件不存在怎么办？

服务会自动创建默认的数据文件结构，无需手动创建。

### Q: 如何查看运行日志？

```bash
tail -f /var/www/AllProject/DevManager/server.log
```

### Q: 页面显示"已断开"怎么办？

1. 检查服务是否运行：`ps aux | grep "node server.js"`
2. 检查端口是否监听：`ss -tlnp | grep 81`
3. 检查防火墙是否开放端口：`ufw status | grep 81`

### Q: 如何停止服务？

```bash
pkill -f "node server.js"
```

---

## 🛠️ 技术栈

- **后端**: Node.js + Express
- **前端**: HTML5 + Tailwind CSS (CDN)
- **数据存储**: JSON 文件
- **实时更新**: 前端轮询 (10秒间隔)

---

## 📜 开源协议

MIT License

---

## 🙏 贡献

欢迎提交 Issue 和 PR！

---

*Generated by Kimi Code CLI - 2026-04-10*
