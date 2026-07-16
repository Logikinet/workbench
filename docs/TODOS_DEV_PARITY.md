# todos.dev 本地对等地图

目标：**把本机 Personal AI Workbench 做成 todos.dev 同款产品体验**（信息架构 + 主操作环 + 关键能力），  
不是再做一个「功能更多但更难用」的运维后台。

> 说明：todos.dev 是在线商业产品（团队、云协调、分享链接、手机推送等）。  
> 本地版复用现有 Service/Todo/Run/Session 引擎，**交互与主路径对齐**；云端 SaaS 专属能力标为「不做」或「后续」。

## 产品主路径（必须一致）

```
对话 (Chief) → 产生 Todo → 出计划 (Plan) → 一键确认并构建 (Build) → 审查/验收 → Done
```

用户不应再手动串：新建 Run → 批计划 → 选角色 → 点执行（除非进「高级」）。

## 功能矩阵

| todos.dev | 本地现状 | 目标状态 |
|-----------|----------|----------|
| 侧栏：Home / Inbox / Todos / Projects / Resources | 已有近似 IA | **对齐命名与分组** |
| Chief 会话派工 | ChatWorkspace + chatBridge | **默认自动 Plan→Build** |
| Todo 列表 + Filters/Sort | TodoBoard 偏后台 | **列表式 + Task›Plan›Build** |
| Task › Plan › Build 分层 | Run 状态机已有 | **列表上可视化 + 一键推进** |
| 确认计划后 Build | decidePlan + execute | **一键「开始执行」** |
| 收件箱（待决策） | WaitingOnMeCenter | 保留并默认入口 |
| Agents 团队成员 + 模型 | Roles + Connections | Agents 页 = 团队 |
| Provider 自备 Key | ConnectionsPanel | 对齐「资源 › 模型」 |
| MCP / Skills | 已有面板 | 资源区保留 |
| 本地执行 / worktree | Codex + Git | 代码任务走 Codex |
| PWA 手机批计划 | 基础 PWA | 继续加强移动批确认 |
| 多机 executor / tds start | 单机 Tray | 后续 |
| 云端团队 / 分享链接 | 无 | **不做（本地优先）** |
| 公开 Webhook 限流等 SaaS | 本地 triggers | 部分有 |
| Voice / 截图圈注 | 无 | 后续 |
| Conversation rewind | 部分会话 | 后续 |

## 分阶段（可交付）

### P0 — 用起来像 todos（当前冲刺）

1. 品牌与导航：todos. 壳、收件箱、Todos、资源、团队  
2. Todos 列表：Task › Plan › Build 芯片 + 行内「开始执行」  
3. 创建 Run 秒开 + 自动批计划 + 自动开跑（已做核心）  
4. Chief 对话：发消息即建 Todo/Run 并推进  

### P1 — 闭环打磨

1. 计划就绪通知进收件箱  
2. 列表批量「Run N」  
3. Agents 页按「成员 + 模型」展示  
4. 移动端底部确认计划  

### P2 — 进阶对等

1. 计划版本切换 UI  
2. Mid-run 追加指令队列  
3. Diff 审查体验  
4. Skills 默认钉到 Agent  
5. Idea library  

### 明确不做（除非以后单独立项）

- 多租户云账号、按席计费、公网分享板  
- 替代 GitHub 的完整 PR 社交  
- 复制 todos 品牌素材/闭源代码  

## 本地映射（引擎不重写）

| todos 概念 | 本地对象 |
|------------|----------|
| Todo | `Todo` |
| Plan | `Run.planning` + `planVersions` |
| Build | `Run.execution` + professional-agent / codex-cli |
| Chief | Session + Firstmate 路由 |
| Builder agent | Role (api / codex-cli) |
| Inbox | waiting-on-me / AskUser / plan approval |
| Machine | 本机 Service + Tray |

## 验收口令（用户可测）

1. 打开首页，输入任务，发送 → 自动出现 Todo 并开始跑  
2. Todos 列表点「开始执行」→ 无需手动批计划  
3. 收件箱能看到卡住需要你的项  
4. 资源里能配模型 / MCP / Skills  
5. 高级面板默认折叠，日常用不到  
