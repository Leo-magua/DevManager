# DevManager 改进 Todo

> 基于代码 review 整理，按优先级排序。每完成一项直接在此文件里把 `[ ]` 改成 `[x]` 并写完成日期即可。

---

## 🔴 高优先级

- [x] **1. 拆分巨型路由文件** (`src/routes/index.js` 2089 行) — 2026-04-23
  - [x] 提取公共工具函数到 `src/routes/utils.js`
  - [x] 创建 `src/routes/auth.js`
  - [x] 创建 `src/routes/projects.js`
  - [x] 创建 `src/routes/features.js` — 看板/任务状态/开始开发
  - [x] 创建 `src/routes/queue.js` — 任务队列/认领/完成/停止/暂停
  - [x] 创建 `src/routes/executor.js` — 手动触发/停止 Agent + 扫描 + 任务回调
  - [x] 创建 `src/routes/nlp.js`
  - [x] 创建 `src/routes/ai.js`
  - [x] 创建 `src/routes/nginx.js`
  - [x] 创建 `src/routes/deploy.js`
  - [x] `src/routes/index.js` 改为纯路由组装入口
  - [x] 补充 `task-queue.js` 缺失的 stub 方法（`getCurrentLogs`/`stopAllTasks`/`resetProjectTask`/`claimAnyTask`）
  - [ ] 创建 `src/routes/auth.js` — 登录/登出/状态
  - [ ] 创建 `src/routes/projects.js` — 项目列表/详情/扫描
  - [ ] 创建 `src/routes/features.js` — 看板/任务状态/开始开发
  - [ ] 创建 `src/routes/queue.js` — 任务队列/认领/完成/停止/暂停
  - [ ] 创建 `src/routes/terminal.js` — 终端缓冲区/输入
  - [ ] 创建 `src/routes/executor.js` — 手动触发/停止 Agent
  - [ ] 创建 `src/routes/nginx.js` — Nginx 配置管理
  - [ ] 创建 `src/routes/nlp.js` — 自然语言解析
  - [ ] `src/routes/index.js` 改为纯路由组装入口

- [ ] **2. 抽象 Agent 执行引擎重复代码**
  - [ ] 提取 `runKimiAgent` / `runCursorAgent` / `runCodexAgent` 的公共逻辑
  - [ ] 统一为 `_runAgent(projectId, task, options)` 方法
  - [ ] 差异点参数化：命令构建、成功/失败正则、超时时间、标签名

- [ ] **3. 消除并发写文件的 Race Condition**
  - [ ] 给每个项目的 `dev_state.json` 写操作加文件级队列（可用 `p-queue` 单实例）
  - [ ] 或者评估迁移到 `better-sqlite3`，JSON 文件仅作导出/备份

- [ ] **4. 密码安全：明文 → bcrypt**
  - [ ] 安装 `bcrypt`
  - [ ] `config.json` 存储 `password_hash` 替代 `password`
  - [ ] 提供首次启动自动生成 hash 或命令行工具 `npm run set-password`
  - [ ] 向后兼容：读取到明文密码时自动迁移为 hash

---

## 🟡 中优先级

- [ ] **5. 前端代码模块化（ES Module）**
  - [ ] `index.html` 改为 `<script type="module" src="js/app.js">`
  - [ ] 各 JS 文件导出函数而非挂全局
  - [ ] 处理模块间的依赖关系（`app.js` → `websocket.js` → `terminal.js` 等）

- [ ] **6. 移除重复挂载的 `express.json()` 中间件**
  - [ ] 删掉 `routes/index.js` 里 `/auth/login` 和 `/terminal/:projectId/input` 上的局部 `express.json()` / `express.text()`
  - [ ] 验证功能不受影响

- [ ] **7. 统一错误处理**
  - [ ] 创建 `src/utils/errors.js`：定义 `AppError`, `NotFoundError`, `AuthError`
  - [ ] 所有路由改用 `next(err)` 抛错，不再各自 `res.status(500).json(...)`
  - [ ] 在 `src/app.js` 底部加全局错误中间件
  - [ ] 禁止空 `catch {}`，至少 `catch (err) { logger.warn(err) }`

- [ ] **8. 审计并修复 `exec/execSync` 命令注入风险**
  - [ ] `nginx-manager.js` 中 `execAsync('nginx -t')` 等改为 `spawn`
  - [ ] `task-monitor.js` 中 `ps aux | grep "${taskId}"` 改为数组参数或严格校验 `taskId`
  - [ ] 所有 shell 命令参数做白名单/转义校验

- [ ] **9. 前端轮询 vs WebSocket 去重**
  - [ ] 评估 `autoRefreshInterval` 轮询的必要性
  - [ ] 改为：WebSocket 推送为主，页面切回时仅拉一次全量数据
  - [ ] 删除或延长轮询间隔到 30s+ 作为兜底

---

## 🟢 低优先级（工程化/体验）

- [ ] **10. 引入结构化日志 `pino`**
  - [ ] 安装 `pino`
  - [ ] 替换所有 `console.log/error` 为 `logger.info/warn/error`
  - [ ] 关键路径加结构化字段：`logger.info({ projectId, featureId }, 'task claimed')`

- [ ] **11. 配置 ESLint + Prettier**
  - [ ] 安装 `eslint`, `prettier`, `eslint-config-prettier`
  - [ ] 写 `.eslintrc.json` 和 `.prettierrc`
  - [ ] `npm run lint` / `npm run format` 脚本
  - [ ] 跑一遍全项目格式化（会产生大量 diff，单独一个 commit）

- [ ] **12. 删除/合并重复扫描逻辑**
  - [ ] `src/routes/index.js` 里的 `scanProjects()` 直接复用 `ProjectScanner`
  - [ ] 或者把 `scanProjects` 彻底删掉，路由层调 `projectScanner.scan()`

- [ ] **13. 看板拖拽排序改为原子操作**
  - [ ] 后端新增 `PUT /api/projects/:id/features/:fid/position { index: N }`
  - [ ] 前端 `handleQueuedReorder` 改为单次请求，不再循环调 `direction: up/down`

- [ ] **14. 清理或完成 Agent 直连 API**
  - [ ] 决定：`src/routes/agent-direct.js` 是补完还是删除？
  - [ ] 如果保留，按 `TODO.md`（旧版）里的设计实现并对接队列
  - [ ] 如果删除，清理相关 TODO 描述

- [ ] **15. 更新 README 与文档**
  - [x] `README.md` 文件结构图更新为 v2 模块化结构
  - [x] 删除过期 `USAGE.md`
  - [x] 删除或归档 `README-v2.md`（避免双文档打架）

- [ ] **16. 补充基础测试**
  - [ ] 安装 `jest`
  - [ ] 至少给 `config/index.js`、`task-queue.js` 的核心方法写单元测试
  - [ ] GitHub Actions CI（可选）

- [ ] **17. 引入 TypeScript（长期）**
  - [ ] 评估成本：当前项目规模是否值得
  - [ ] 渐进方案：先把 `src/config/`、`src/utils/` 改写 `.ts`
  - [ ] 或者至少写 JSDoc 类型注解，配 `tsc --noEmit` 做类型检查

---

## 📌 当前进行中

_把正在做的项移到这儿，避免多人/多 session 重复开工。_

- 暂无

---

*Reviewed on 2026-04-23*
