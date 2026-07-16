# todos.dev 产品研究（第一性原理）

> 研究依据：官方站点 todos.dev / features / install；本地 `_todos_cli/dist/index.js` 反查字符串与状态机定义。  
> 目的：在继续写本地「照搬」之前，先把**真产品**说清楚，避免用工作台面板冒充 todos。

---

## 1. 它是什么（一句话）

**todos.dev = 人机协作的任务驱动工作区（task-driven workspace）**  
不是「聊天机器人」，也不是「运维式 Agent 管理后台」。

核心承诺：

> 你派活、做决策；Agent 把 Todo 从 **计划 → 构建 → 审查 → 完成** 跑完。  
> **代码跑在你自己的机器上**；模型 Key 也留在你机器上。

---

## 2. 角色模型（谁干什么）

| 角色 | 职责 |
|------|------|
| **人（Human）** | 提需求、确认计划、回答问题、验收 diff/PR、批高危能力 |
| **Chief** | 常驻统筹：记项目/记忆/章程（charter）、建议下一步、拆 Todo、盯进度、必要时「Run N」 |
| **Builder（多个）** | 执行构建：每个 Agent 自带 provider/model/thinking level；可不同模型 |
| **Machine / Executor** | 本机守护进程（`tds start`）：注册机器、跑 shell、隔离 worktree、同步工作区 |
| **Todos Server** | 协调：项目、对话、计划、审查、通知、团队；**不持有也不计费推理** |

关键点：**规划 Agent 与执行 Agent 可以是不同模型**（Plan 用 opus，Build 用 sonnet 等）。

---

## 3. 生命周期（比 Task›Plan›Build 更完整）

官方文案与移动端路径：

```
Todo → Planning → Confirm → Building → Review → Done
```

营销层常写 **Task › Plan › Build**；CLI 状态机更细：

### 3.1 步骤定义（来自 CLI `STEP_DEF`）

| step kind | track | sink | busy 相位 | rest（等人） | notify |
|-----------|-------|------|-----------|--------------|--------|
| `plan` | plan | chat | planning | **confirm** | plan_ready |
| `plan_revision` | plan | chat | planning | confirm | plan_ready |
| `implement` | implement | chat | **building** | **review** | build_review |
| `implement_revision` | implement | chat | building | review | build_review |
| `merge` | implement | chat | building | review | build_review |
| `plan_review` | plan | review | — | — | — |
| `implement_review` | implement | review | — | — | — |
| `chief` | — | chief | — | — | — |

含义：

1. **Planning**：Chief/Planner 写计划 → 进入 **confirm**（等人批）
2. 人确认后才 **Building**
3. Build 完进入 **review**（人看 diff/结果）
4. 可 revision 回环；还有 **cross-review**（另一 Agent 批计划/改动）
5. Chief 会话是独立 sink，用来「建议下两个 Todo → Run 2」

`BUSY_PHASES = planning | building`  
`ACTIVE_BUILD_PHASES = queued | planning | building`

---

## 4. 用户每天的操作环（真 todos 体感）

```
A. 跟人/Chief 说话或新建 Todo
        ↓
B. 出现 Todo 列表项（To Do）
        ↓
C. Agent 自动/被派去 Planning（列表上 Task›Plan›Build 有进度）
        ↓
D. Inbox/推送：Plan ready · confirm to build   ← 人只点确认
        ↓
E. 本机 executor 在 isolation worktree 里 Build
        ↓
F. 本地预览（~1s 镜像到本机 dev server）/ 看 diff
        ↓
G. Review → 合入 GitHub PR 或打回 revision
        ↓
H. Done；Chief 记住并建议下一批
```

**人的主路径只有：说话 / 确认计划 / 看结果 / 纠偏。**  
不是：新建 Run → 批计划面板 → 选角色 → 点 Professional Agent → 点 Codex → …

---

## 5. 信息架构（产品壳）

从官网与 PWA 描述归纳：

| 区域 | 用途 |
|------|------|
| **Team 侧栏** | 人 + Agent 成员（Chief / Builder×N，每人一个模型徽章） |
| **Chief 对话** | 常驻会话：摘要进度、提案 Todo、一键 Run N |
| **Todos 板** | 列表 + Filters/Sort；每项 Task›Plan›Build 可视化 |
| **Inbox / 通知** | 只在「要你决策」时找你（plan confirm、review） |
| **Projects** | 绑定仓库/工作区 |
| **Resources** | Providers（自备 Key）、MCP、Skills、Triggers… |
| **Machines** | `tds start` 上线的执行器；shell 开关、并发 |
| **手机 PWA** | 远程遥控：语音建 Todo、确认计划、看结果；**执行仍在电脑** |

---

## 6. 执行与隔离（为什么和「云 coding agent」不同）

| 点 | todos.dev |
|----|-----------|
| 代码在哪跑 | **你的机器**（Node + git 即可） |
| 如何注册执行器 | **`tds start`** → machine enroll / presence heartbeat |
| 构建隔离 | **per-conversation git worktree**（`worktreeDir ~ conversationId`） |
| 预览 | remote tree 镜像到本机 ~1s，可起 dev server |
| 合入 | PR 到 GitHub；merge 能力默认关，按 Agent 授权 |
| 密钥 | **只在本机**；服务端协调，不计费、不截流推理 |
| 远程 shell | 需 machine 开启 shell + agent 有 `remote_shell` grant |

CLI 文案要点：

- 团队要有 **online machine**（`tds start`）
- Agent 需要相应 **tool grants**
- worktree 可 **reset/clean 到某 commit**（支持 conversation rewind）

---

## 7. 多 Agent 怎么「分」

不是我们本地那种「一个 Run 上硬塞多个 Professional Agent 面板」，而是：

1. **Todo 级分层**：先 Plan track，再 Implement track  
2. **Agent 级模型拆分**：Planner 模型 ≠ Builder 模型  
3. **权限级**：merge / create tag / remote shell **默认关**，按 Agent 开  
4. **Skills**：可钉到 Agent 作默认  
5. **Chief 编排**：跨 Todo 建议与批量 Run  
6. **机器并发**：`maxConcurrentTasks` / `maxParallelBuilds`（free: 3 并行 build）

---

## 8. 功能全景（官网 Features 清单）

**主能力**

- Layered Task › Plan › Build  
- Standing Chief + 提案 / Run N  
- 本机预览 + worktree  
- 手机 PWA + 克制通知  
- MCP Server（Claude Code / Cursor 读写 board、起 build）  
- 自备模型 Key（Claude / GPT / Gemini / Ollama / 兼容接口）  
- Plan vs Build 模型拆分 + 细粒度 tool grants + 默认 skills  

**Also in the box**

- AI cross-review  
- Steer mid-run（构建中 composer 仍可追加）  
- Conversation rewind（消息 + worktree + model session）  
- Structured questions（选项卡）  
- Voice / Screenshot markup  
- Mentions：`/` skills · `#` todos · `~` projects · `&` machines  
- Skills 库（GitHub 一键导入）  
- GitHub 风格 per-file diff  
- Plan versions  
- Token/费用透明  
- Run history（一键重跑 / 复用计划）  
- Idea library  
- 双轨审计（人 / Agent）  
- Inbox 全量记录 + 可选推送  

**商业**

- Free forever 起步；Team 平面价（非按 seat / 非按 token 加价）  
- free：maxMembers 3, maxMachines 2, maxParallelBuilds 3  

---

## 9. 和「本地 Personal AI Workbench」的本质差距

| 维度 | todos.dev | 我们当前（诚实） |
|------|-----------|------------------|
| 产品心智 | **Todo 板 + Chief 会话** 是主 UI | 多面板工作台 + 后贴的 chatBridge |
| 主循环 | **确认计划 = 开跑** | 曾是：Run/计划/角色/Codex 多步；后补 autoGo 仍碎 |
| 规划 vs 执行 | **两个 track、可不同 Agent/模型** | 模板计划 + 单 Run 编排，分工弱 |
| 执行器 | **`tds start` 机器守护 + worktree** | 进程内 API Agent / 可选 Codex，缺「机器」概念 |
| 隔离 | conversation worktree + rewind | worktree 有，但未绑 conversation 产品语义 |
| 团队 | 人+Agent 成员无限 Agent | 基本单用户本地 |
| 手机 | 一等公民遥控 | PWA 壳弱 |
| 对外 | MCP 读写 board | 有 MCP 能力模块，但不是 board 产品 |
| 完成定义 | Review/PR/Done | awaiting_review / acceptance，UI 未收成一条线 |

**结论：**  
把 Firstmate/Run/审批面板「包一层中文」**不等于** todos。  
todos 是 **Todo 对象状态机 + Chief 编排 + 本机 executor + 人只做确认** 的产品。

---

## 10. 若要真对齐，正确顺序（研究结论 → 实现优先级）

### P0 — 产品骨架（没有就不算 todos）

1. **Todo 状态机**对齐：  
   `todo → planning → confirm → building → review → done`  
   UI 只暴露 Task › Plan › Build + 当前等人相位  
2. **一个主按钮语义**：`确认并构建` / `开始` = 批 plan + 派 builder  
3. **Chief 会话**：产出 Todo 提案 + Run N，而不是泛聊天桥  
4. **Builder 执行**：绑定 project/repo + worktree；无 Codex 时也要有一条诚实可用的本机构建路径  
5. **Inbox**：仅 plan_ready / build_review / ask_user  

### P1 — 多 Agent 像 todos

1. Plan Agent ≠ Build Agent（配置层就拆开）  
2. 权限 grant 默认关  
3. 子任务可见，但用户不操作 DAG 面板  
4. mid-run 追加指令  

### P2 — 平台味

1. `tds`-like machine 守护与 presence  
2. MCP board API  
3. Skills 钉 Agent  
4. Plan versions / rewind  
5. 手机确认底栏  

### 明确不要先做

- 再堆更多「运维面板」当功能完成  
- 用假进度冒充实跑  
- 在没跑通 **确认计划→本机产出文件/diff** 前做 Team/分享链接  

---

## 11. 验收口令（对标 todos 用户体感）

用户应能在 3 分钟内完成：

1. 打开工作区 → 对 Chief 说一句话  
2. 板上出现 1 个 Todo，状态走向 Planning  
3. 收到/看到 **Plan ready，确认构建**  
4. 一点确认 → Building  
5. 本机工作区/worktree 出现真实改动  
6. Review 里能看结果 → 标 Done  

做不到 4–5，就仍是壳。

---

## 12. 参考来源

- https://todos.dev/  
- https://todos.dev/features  
- https://todos.dev/install  
- 本地 `_todos_cli/dist/index.js`：`STEP_DEF`、`PLAN_LIMITS`、machine enroll、worktreeDir、`tds start` 文案  
