# Personal AI Workbench

Windows 本地个人 AI 工作台。在本机用 Todo 驱动代理：计划、执行、审查、验收，全程不把服务暴露到公网。

## Features

- 本地 PWA + 仅 `127.0.0.1` 的 Node 服务
- Project 绑定本机工作区，Todo 看板与 Run 时间线
- OpenAI 兼容模型连接（API Key 存 Windows 凭据管理器）
- Agent Role / 计划审批 / API 专业代理执行
- Codex CLI 接入、Git Worktree 隔离修改与 Diff
- 独立审查与用户验收、步骤检查点恢复
- 任务队列与资源保护、数据备份迁移
- Windows 托盘启停服务与安装脚本

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
