# Personal AI Workbench

Windows 本地个人 AI 工作台。在本机用 Todo 驱动代理：计划、执行、审查、验收，全程不把服务暴露到公网。

## What it can do

### 日常使用

- **当本地工作台用**：浏览器安装成 PWA，连接本机 Agent 服务，显示在线 / 离线 / 异常，服务挂了有恢复提示。
- **管项目目录**：创建 Project，绑定一个本机文件夹作为工作区；重启后仍能找回；代理默认出不了这个目录。
- **管任务看板**：用标题快速建 Todo，可挂到某个 Project 或先放收件箱；按待处理、运行中、等待确认、待验收、已完成查看；支持搜索、编辑、归档、恢复。
- **多次尝试不覆盖**：同一个 Todo 可以开多次独立 Run，各自保留消息、计划、日志、审查和成果；能对照历史时间线。

### 接模型和代理

- **接任意 OpenAI 兼容接口**：自定义 Base URL、模型 ID、API Key；可测试连接；Key 进 Windows 凭据管理器，不落明文库。
- **配可复用 Agent Role**：职责、系统指令、模型、Harness、Skills、Tools、权限；可复制、停用、删除；可限制 Firstmate 是否自动调用。
- **计划先批再干**：Firstmate 识别任务类型，Secondmate 出结构化计划（步骤、验收标准、风险、禁止项）；你批准 / 退回 / 取消后才执行；批准前不改正式成果。
- **API 专业代理干活**：在批准的工作区里真实写文件、登记 Artifact；时间线看状态和工具活动；失败可保留进度并重试；临时角色可确认后存成长期 Role。
- **接 Codex CLI**：检测本机是否安装、是否已登录；用 Codex Role 在项目目录跑代码任务；输出进时间线；可停止进程；登录失效会暂停并提示。

### 写代码时更可控

- **隔离改代码**：Git 项目在独立 Worktree 里改，主工作区脏了会先拦住，避免直接污染主目录。
- **看 Diff 和跑检查**：改完看修改文件列表和完整 Diff；按已批准计划跑测试 / 类型检查 / 构建，结果落库。
- **可整单放弃**：不接受本次修改就丢弃 Worktree，主工作区保持原样。

### 质量与安全

- **执行者和审查者分开**：独立 Reviewer 对照目标、计划、成果和证据出结论，不直接改文件。
- **审查不过不能假装完成**：失败可自动派发一轮修复再复审；默认最多自动修一轮；你点验收通过后，Todo / Run 才算完成。
- **随时能停、能纠偏**：权限不够或危险操作（删文件、出工作区、装系统级东西、外发等）会暂停等你确认；可停单个 Run；可小范围纠偏；大改目标要重新批计划。
- **中断了还能续**：关键步骤有检查点；关机 / 重启后能看到完成、失败、中断；恢复前检查工作区是否被外部改过；危险步骤不会偷偷自动重放。
- **本机别被拖垮**：默认同时只跑一个写入型代理；调研类可读任务可并行（默认最多 2）；可配超时、重试、并行上限；一键停掉全部 Run；磁盘或资源不够会暂停新任务并说明原因。

### 数据与安装

- **备份迁移**：导出 Project 索引、Todo、Run、Role、非敏感设置；**不**打包大仓库、**不**带走 API Key；换机恢复时可重新关联目录，缺的目录标成待修复；导入失败不会弄坏当前数据。
- **Windows 日常安装**：安装脚本部署本机服务；托盘里启动 / 停止 / 重启、紧急停止全部任务、开关开机自启；卸载默认不删你的项目目录和正式数据。

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+
- Git
- 可选：[Codex CLI](https://github.com/openai/codex)

## Install

```bash
git clone https://github.com/Logikinet/workbench.git
cd workbench
npm install
```

## Development

```bash
npm run dev
```

- API：`http://127.0.0.1:41731`
- 前端由 Vite 开发服务器启动（`apps/web`）

浏览器打开前端地址即可使用。服务只接受本机连接。

## Build

```bash
npm run build
```

## Test

```bash
npm test
npm run typecheck
```

## Windows install (optional)

将构建结果安装到本机（托盘、快捷方式、开机自启等）：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Install-PersonalAIWorkbench.ps1
```

默认路径：

| Path | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\Programs\PersonalAIWorkbench` | 程序 |
| `%LOCALAPPDATA%\PersonalAIWorkbench` | 数据 |

启动托盘：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

卸载脚本见 `packaging/windows/Uninstall-PersonalAIWorkbench.ps1`。默认不会删除 Project 工作区与数据，除非显式确认。

## Project structure

```text
apps/
  service/   # local Agent Service (Express)
  web/       # PWA frontend
  tray/      # tray / process helpers
packaging/
  windows/   # install / upgrade / uninstall scripts
```

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `PAW_SERVICE_PORT` | Service port | `41731` |
| `PAW_DATA_DIR` | Data directory | `%LOCALAPPDATA%\PersonalAIWorkbench` |
| `PAW_WEB_DIST` | Built web assets for same-origin serving | — |

模型连接、Role、队列、备份等在应用界面中配置。

## Usage overview

1. 启动服务与前端（开发：`npm run dev`，或安装后用托盘启动）。
2. 在界面中创建 Project 并授权本机工作目录。
3. 配置模型连接（OpenAI 兼容接口）。
4. 创建 Todo，走计划批准 → 执行 → 审查 → 验收。
5. 代码类任务可使用 Codex / Worktree，查看 Diff 与验证结果。

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start service + web in development |
| `npm run build` | Build service, web, and tray |
| `npm test` | Run tests |
| `npm run typecheck` | TypeScript check |
| `npm run pack:windows` | Run Windows install script |

## License

No license file is included yet. Add a `LICENSE` if you plan to distribute the project.
