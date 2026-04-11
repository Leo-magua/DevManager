# DevManager 待办事项

## 🆕 新需求：Agent 直连 API（后端直接下发需求）

**状态**: 待实现  
**提出时间**: 2026-04-10  
**优先级**: 中  

### 背景
当前所有需求都需要通过前端页面录入，但未来可能需要：
1. 后端系统检测到问题（慢查询、内存泄漏）自动创建需求并修复
2. 定时任务触发优化（清理日志、压缩图片）
3. 其他 AI Agent 直接通过 API 下发需求到项目

### 核心问题
- 后端创建的需求是否也要写入 `dev_state.json`？
- AI 即时闭环完成的需求如何标记？
- 前端看板如何区分展示人工需求 vs 系统自动化需求？

### 方案设计

#### 数据结构（已设计）
```json
{
  "id": "F010",
  "name": "自动优化数据库索引",
  "status": "Completed",
  "source": "backend",           // frontend | backend | agent
  "auto_completed": true,        // 是否自动闭环
  "execution": {
    "agent": "kimi",
    "started_at": "2026-04-10T10:00:00Z",
    "completed_at": "2026-04-10T10:05:00Z",
    "duration_seconds": 300
  }
}
```

#### API 设计（已设计）
- `POST /api/agent/direct` - 单条创建需求
- `POST /api/agent/direct/batch` - 批量创建
- `GET /api/agent/direct/stats` - 统计后端创建的需求

参数：
```typescript
{
  project_id: string,
  name: string,
  description?: string,
  priority?: 'High' | 'Medium' | 'Low',
  category?: string,
  auto_execute?: boolean,   // 是否立即执行
  record_only?: boolean     // 仅记录不执行
}
```

### 实现状态
- [x] 模块拆分完成
- [x] API 设计完成（见 `src/routes/agent-direct.js` 初稿）
- [ ] 与现有任务队列集成
- [ ] 前端展示优化（区分人工/AI需求）
- [ ] 测试验证

### 文件位置
- 初稿代码: `src/routes/agent-direct.js`（已创建，待完善）

---

## 📋 其他待办

### 已完成 ✅
- [x] 项目模块化拆分
- [x] 配置模块分离
- [x] WebSocket 模块分离
- [x] 核心模块分离（任务队列、Agent执行、项目扫描、状态同步）
- [x] 服务模块分离（部署管理、任务监控、NLP解析）
- [x] 路由模块分离

### 待办 ⏳
- [ ] 验证新模块化结构功能完整性
- [ ] 更新文档（README、USAGE）
- [ ] 添加单元测试
