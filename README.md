# Personal AI Workbench

本地 Windows 上的个人 AI 工作台：把 **Todo → 计划批准 → 代理执行 → 审查 → 验收** 做成一条可控闭环。

面向单人、本机运行。服务只监听 `127.0.0.1`，API Key 走 Windows Credential Manager，Project 工作区有授权边界；可选 Codex CLI 与隔离 Git Worktree。

---

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 本地 PWA | 可安装的前端壳，展示服务在线/离线状态 |
| Project | 绑定唯一 Main Workspace，带目录授权与路径边界 |
| Todo 看板 | 待处理 / 运行中 / 等待确认 / 待验收 / 已完成 |
| Run 时间线 | 同一 Todo 可多次独立 Run，历史不覆盖 |
| 模型连接 | OpenAI-compatible Base URL / 模型 ID；Key 存本机凭据库 |
| Agent Role | 配置 Harness、Skills、Tools、权限；Firstmate 规则受保护 |
| 计划审批 | Firstmate 编排 + Secondmate 计划；批准前不写正式成果 |
| Professional Agent | API 代理在工作区内执行并登记 Artifact |
| Codex CLI | 官方编码 Harness：检测登录、流式日志、可靠停止、写会话确认 |
| Worktree / Diff | Git 项目隔离修改、Diff、批准的验证命令、可放弃 |
| 审查闭环 | 独立 Reviewer + 有限自动修复 + 用户验收后才算完成 |
| 检查点恢复 | 步骤级检查点；危险操作不自动重放 |
| 队列与资源 | 写并行默认 1；只读默认 2；磁盘不足暂停；一键停全部 |
| 备份迁移 | 导出配置与历史；不含密钥与大仓库；导入失败可回滚 |
| Windows 托盘 | 启停服务、紧急停止、开机自启、安装/升级/卸载脚本 |

---

## 仓库结构

```text
personal-ai-workbench/
├── apps/
│   ├── service/     # 本地 Express Agent Service（loopback）
│   ├── web/         # PWA 前端
│   └── tray/        # 托盘 CLI / 进程管理
├── packaging/
│   └── windows/     # 安装、升级、卸载、TrayHost 脚本
├── package.json     # npm workspaces
└── vitest.config.ts
```

---

## 环境要求

- Windows 10/11（目标平台）
- Node.js 20+（开发与运行）
- Git（Worktree / 指纹检测）
- 可选：[Codex CLI](https://github.com/openai/codex)（编码 Harness）
- 可选：OpenAI-compatible 模型 API

---

## 快速开始（开发）

```powershell
git clone https://github.com/Logikinet/workbench.git
cd workbench
npm install
npm run dev
```

- 服务默认：`http://127.0.0.1:41731`
- Web 开发服务器由 Vite 启动（见 `apps/web`）

### 验证

```powershell
npm test
npm run typecheck
npm run build
```

---

## Windows 安装（日常使用）

先构建，再跑安装脚本：

```powershell
npm install
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Install-PersonalAIWorkbench.ps1
```

默认布局：

| 路径 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\PersonalAIWorkbench` | 程序文件 |
| `%LOCALAPPDATA%\PersonalAIWorkbench` | 数据与状态 |

安装后可通过桌面快捷方式或托盘启动服务。卸载默认**保留** Project 工作区与正式数据；删除数据需显式确认。

```powershell
# 托盘（NotifyIcon）
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

---

## 主闭环（概念）

```text
Todo
  → Firstmate 识别 / 编排
  → Secondmate 计划（版本历史）
  → 用户批准
  → Professional Agent 或 Codex 执行
  → （Git）Worktree + Diff + 验证
  → 独立 Reviewer
  → 用户验收
  → 完成
```

关键约束（实现中强制）：

- 服务仅本机 loopback，不默认暴露局域网
- 未授权不得访问 Project 工作区外路径
- 删除/覆盖/外发等危险操作需确认；恢复时不自动重放
- 审查通过且用户接受前，Todo 不能标为完成
- 普通备份不含 API Key / Harness 登录凭据

---

## 配置提示

| 环境变量 | 含义 |
| --- | --- |
| `PAW_SERVICE_PORT` | 服务端口（默认 `41731`） |
| `PAW_DATA_DIR` | 数据目录 |
| `PAW_WEB_DIST` | 同域托管的 PWA 构建目录 |
| `PAW_SERVICE_VERSION` | 健康检查版本号 |

模型连接、Role、队列上下限、备份导入导出等在 PWA 面板中配置。

---

## 与 todos.dev 的关系

本项目在产品心智上接近 [Todos](https://todos.dev/) 的 **Todo → 计划 → 构建 → 审查 → 验收** 主链，但是：

- **单人、Windows 本机、自托管** 的 Agent 控制台 / Harness
- **不是** todos.dev 官方客户端
- 不提供团队协作、云协调、多执行机注册、GitHub 一键 merge 等 SaaS 能力

更适合：在自己电脑上可控地跑 API 代理与 Codex，并保留完整审计与安全门禁。

---

## 技术栈

- **Service**：Node.js、TypeScript、Express、Vitest
- **Web**：React、Vite、vite-plugin-pwa
- **Tray / 安装**：Node 托盘逻辑 + PowerShell 安装脚本

---

## 许可证

当前仓库未附带独立许可证文件。若需开源分发，请自行补充 `LICENSE`。

---

## 状态

首版任务切片（本地工作台 01–16）已实现并通过自动化测试与类型检查构建。真实 Codex CLI 登录执行、托盘交互式验收建议在目标 Windows 环境再做一次手工确认。
