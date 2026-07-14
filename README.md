# Personal AI Workbench

Windows 本地个人 AI 工作台：你把任务丢进去，代理在本机帮你调研、写材料、做课设/写代码，你负责批计划和验收。服务只跑在本机，不暴露到公网。

## What it can do

### 从「交任务」到「交作业」

你平时可以这样用：

1. **丢一条 Todo**  
   例如：「帮我调研某课题并写一篇课程论文」「做完这个课设，要求能跑通 demo」「把这个小功能补上并写说明」。
2. **系统先出计划给你看**  
   会拆成调研 / 大纲 / 撰写 / 改代码 / 自测等步骤，标清验收标准和风险；你批准后才真正动手，批之前不会乱改你的正式文件。
3. **在本机工作区自动干活**  
   代理在你指定的文件夹里读资料、写文档、改代码、生成交付物（论文草稿、报告、代码、说明等），过程都能在时间线里看到。
4. **自己审查一遍再让你验收**  
   代理自称做完不算完：会对照目标和计划做审查，不过可以修一轮；最后由你点接受，任务才算完成。
5. **中途可插手**  
   随时暂停、停止、纠偏方向；危险操作（删文件、出目录等）会先问你；电脑关机或服务挂了，长任务还能按检查点接着做。

### 典型场景

| 你想干什么 | 工作台怎么帮你 |
| --- | --- |
| **自动调研** | 按题目拆调研计划，在工作区整理笔记、提纲、资料摘要，形成可继续写的底稿 |
| **写论文 / 课程报告** | 从大纲到分节撰写、改结构、补说明；产出落在本机目录，方便你再改再交 |
| **做课设 / 大作业** | 绑定课设文件夹；写代码、补 README、跑测试或构建；Git 项目可在隔离区改，不满意整单放弃 |
| **修 bug / 加功能** | 接 Codex 等编码代理在项目里改；看 Diff 和检查结果，过了你再收 |
| **多门课 / 多个项目并行管** | 多个 Project + Todo 看板；同一任务可多次重跑，历史不互相覆盖 |
| **换电脑接着干** | 备份任务与配置（不含密钥和大仓库），恢复后重新关联本地文件夹 |

### 你需要准备什么

- 本机一个（或多个）项目文件夹：论文目录、课设仓库、作业目录等  
- 自己的模型 API（OpenAI 兼容接口），Key 存在 Windows 凭据里  
- 写代码时可选安装 Codex CLI  

### 它不会替你做的事

- 不会默认连公网当云端 SaaS，也不会把 Key 和仓库整包上传  
- 不会在你没批计划、没过审查/验收时，把 Todo 直接标成「已完成」  
- 不会在恢复中断任务时，自动重放删除、覆盖、外发这类危险操作  

底层还包含：本地 PWA、角色与权限、Worktree/Diff、队列与资源保护、托盘安装等，保证上面这些场景在本机可控地跑完。

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

1. 启动服务与前端（`npm run dev`，或安装后用托盘启动）。
2. 配置你自己的模型 API。
3. 新建 Project，选中论文/课设/代码所在文件夹并授权。
4. 新建 Todo，写清楚要调研什么、写什么、做到什么程度。
5. 看计划 → 批准 → 等代理在本机执行 → 看审查结果 → 你验收交付物。
6. 代码课设可看 Diff / 测试结果；不满意可放弃本次修改再重跑。

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
