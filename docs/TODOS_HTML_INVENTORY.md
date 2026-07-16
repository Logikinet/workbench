# 桌面 `todos html` 快照盘点

路径：`C:\Users\Administrator\Desktop\todos html`  
数量：**56 个 .htm**（浏览器整页保存）

## 已覆盖的真实 App 路由（很有价值）

从 URL 提取到的 **已登录 App 结构**（不是营销站）：

| 路由 | 含义 |
|------|------|
| `/app` | 团队/主壳（侧栏「团队」） |
| `/chief` | 总管 Chief |
| `/chief/settings` | 总管设置 |
| `/chief/settings?tab=charter` | 章程 Charter |
| `/chief/settings?tab=memory` | 记忆 Memory |
| `/projects/:id` | 项目主视图（常带右侧 todo panel） |
| `/projects/:id/settings` | 项目设置 |
| `/projects/:id/settings?tab=tags` | 项目标签 |
| `/agents/:id` | 单个 Agent 详情 |
| `/resources/providers` | 资源 › 模型 |
| `/resources/skills` | 资源 › 技能 |
| `/resources/skills/new` | 新建技能 |
| `/resources/secrets` | 资源 › 密钥 |
| `/api-keys` | API Keys |
| `/teams/:id/settings?tab=members` | 团队成员 |
| `/teams/:id/settings?tab=machines` | 机器 / executors |
| `/teams/:id/settings?tab=projects` | 团队项目 |
| `/teams/:id/settings?tab=github` | GitHub 集成 |

### 交互模式（从 URL 学到的）

- 大量页面带 `?panel=todo%3A{todoId}` → **右侧滑出 Todo 详情面板**（主内容 + panel 叠层）
- 还有 `panel=todo%3A{id}%3Atask` → Todo 内 **task 子视图**
- 中文侧栏文案片段：**总管 · 新建 · 项目 · 资源 · 技能 · 密钥 · 模型**
- 导航含：`/app`（团队）、`/inbox`（链接存在）、项目列表、资源

## 局限（HTML 本身的问题）

1. **SPA 保存不完整**：去 script 后正文往往只剩壳/侧栏，**中间主内容区文字很少**（hydration 或懒加载未进静态 HTML）。
2. 部分页被「AIX智能下载器」工具条污染。
3. **几乎没有截图像素级布局**（间距、字号、暗色 token 靠猜）。
4. 多个文件 URL 相同/近似（重复保存）。

## 明显缺失（建议你再补）

### A. 最高优先（做 UI 必看）

| 缺什么 | 为什么需要 | 怎么弄 |
|--------|------------|--------|
| **`/inbox` 整页** | 确认计划、通知入口 | 打开 Inbox 再另存为 |
| **Todos 列表无 panel** | 干净板子，不是始终开着某个 todo | `/projects/...` 或主板关掉右侧 panel 再存 |
| **Todo 详情全屏/panel 展开** | Plan / Confirm / Build / 对话 / diff | 打开一个 **Plan ready** 和 **Building** 各存一页 |
| **Confirm Plan 弹层/页** | 核心操作门闩 | 点到确认计划界面再存 |
| **Building 进行中** | 流式输出、工具调用 UI | 跑一个 build 时存 |
| **截图 PNG/WebP** 上述每一屏 | 比 HTML 更准 | Win+Shift+S 或浏览器截长图 |

### B. 中优先

| 缺什么 | 说明 |
|--------|------|
| `/inbox` 无 panel | 见上 |
| Resources 首页（若有）/ **MCP** / **Triggers** | 你现有 providers/skills/secrets，缺 MCP、触发器 |
| **新建 Todo / 新建项目** 对话框 | 空状态 + 表单 |
| **Chief 空会话** vs **有提案 Run 2** | 两种状态 |
| Agent 列表页（非单个 agent） | 若侧栏有「全部 agents」 |
| **Machines 在线 `tds start` 状态** | 执行器页 |
| 手机宽度 / 窄屏 | 响应式 |

### C. 可选

- Network 里 **JSON API 响应**（F12 → 复制 response，脱敏）— 字段名比猜强  
- 设计 token：DevTools → Computed 抄 `--surface` 等  
- 英文界面若可切换，存一版英文对照  

## 建议你怎么补（最省事）

1. 浏览器打开 todos 登录后  
2. **每一屏：① 整页另存为 .htm  ② 再截一张全屏 PNG**  
3. 按文件夹分类，例如：

```
Desktop/todos-ref/
  01-chief/
  02-inbox/
  03-todos-board/
  04-todo-plan-ready/
  05-todo-building/
  06-todo-review/
  07-project/
  08-resources-providers/
  09-resources-skills/
  10-resources-secrets/
  11-agent/
  12-team-machines/
  13-confirm-plan-modal/
```

4. 文件名用中文也行：`inbox-plan-ready.png`

## 结论

- **这些 HTML 已经够画出 IA（信息架构）和路由**，比官网有用得多。  
- **不够一比一抠视觉和确认计划细节**，因为主内容区在静态 HTML 里残缺。  
- **最需要你再下的：Inbox、干净 Todos 板、Plan ready / Confirm / Building 各一屏 + 全套截图。**

有了截图 + 补那几页，就可以按真界面改本地壳，而不是继续猜。
