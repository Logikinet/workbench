# Personal AI Workbench

Windows 本机个人 AI 工作台。产品操作对齐 **[todos.dev](https://todos.dev)**：在项目里建任务 → 规划 Agent 出方案 → 你确认 → 执行 Agent 落地 → 待验收 / Diff 高亮 → 完成。服务只监听 `127.0.0.1`，密钥进 Windows 凭据库，不默认 `git push`。

仓库：https://github.com/Logikinet/workbench

---

## 产品主路径（照搬 todos）

```text
关联 GitHub 帐号
→ 新建「项目」（选择 GitHub 仓库，自动 clone 到本机）
→ 在项目里「新建任务」
→ 「开始」：规划 Agent / 执行 Agent（可分用）
→ 确认方案（Context / Changes）
→ 执行：日志、Token 用量、文件 Diff 绿/红高亮
→ 待验收 → 「完成」
```

| 能力 | 说明 |
| --- | --- |
| **项目 = 绑仓库** | 设置 › GitHub 粘贴 PAT；创建项目时从仓库列表选择（同 todos） |
| **任务在项目内** | 侧栏「+ 新建」是建**项目**；板内「+ 新建任务」才是任务 |
| **多 Agent** | 开始任务弹窗：规划 / 执行分用不同 Agent |
| **操控栏** | `#n`、状态胶囊、任务 › 规划 › 执行、确认方案 / 完成、Token |
| **Token 用量** | Run 累计 prompt / completion；弹窗按模型明细 |
| **Diff 预览** | 执行后 worktree / 变更文件列表 + 高亮 |
| **栏宽可拖** | 总管三栏、项目详情栏宽度可拖，写入 localStorage |
| **成员 / Agent** | 设置 › 成员：列表 + 创建 Agent（名称 / 机器 / 模型） |

底层仍是完整工程能力：计划批准门闩、检查点恢复、Codex Worktree、独立审查、文档/课设流水线等（见下文）。

---

## 推荐启动方式（真界面，不是空壳）

**日常请只打开：**

```text
http://127.0.0.1:41731
```

用 **Service 托管已构建的前端**（`PAW_WEB_DIST`），避免只开 Vite 却连不上 API。

```powershell
cd workbench   # 仓库根目录

npm install
npm run build --workspace=@paw/web

$env:PAW_WEB_DIST = (Resolve-Path "apps\web\dist").Path
npm run dev --workspace=@paw/service
# 或: cd apps\service; npx tsx src\main.ts
```

改过 UI 后重新 `npm run build --workspace=@paw/web`，再重启 service。

更短说明见 [`HOW_TO_RUN.md`](./HOW_TO_RUN.md)。

### 开发双进程（可选）

```powershell
npm run dev
```

- API：`http://127.0.0.1:41731`
- 前端：Vite 终端地址（常见 `5173`）；需保证 API 可达

---

## 首次配置（界面）

1. **资源 › 模型服务** — 添加 OpenAI 兼容连接；API Key 进 Windows 凭据，不写明文配置。  
2. **设置 › GitHub** — 粘贴 PAT（classic 勾 `repo`，或 fine-grained 可读 Contents）→ 关联帐号。  
3. **侧栏「+ 新建」** — 项目名称 + **选择 GitHub 仓库** → 自动 clone 到  
   `%LOCALAPPDATA%\PersonalAIWorkbench\github-clones\<owner>__<repo>`  
4. **设置 › 成员** — 创建 Agent，绑定模型；或在「开始任务」里选规划 / 执行 Agent。  
5. 无项目时服务会创建「本机默认工作区」作兜底。

---

## 日常：todos 风格任务闭环

1. 左侧点进某个 **项目**（显示 `owner/repo ↗`）。  
2. **+ 新建任务** → 填标题。  
3. **开始** → 选规划 / 执行 Agent → 先做规划。  
4. 看 **Context / Changes** → **确认方案**。  
5. 执行中可补充说明；看 **Token 用量**、时间线。  
6. 有改动时看 **Diff 高亮** → **完成** 验收。  

代码任务若配置了 Codex CLI 角色，走隔离 Worktree；否则 API Agent 在已绑定工作区内执行。

---

## 还能做什么（工程能力）

| 场景 | 能力 |
| --- | --- |
| 调研 | 证据优先检索，`research.md` / 来源清单 |
| 论文 / 报告 | Zotero 文献 → 提纲批准 → 分章撰写 → OfficeCLI DOCX → 审查 |
| 课设 | 任务书拆解、评分点、交付 ZIP |
| 写代码 | API 工具循环或 Codex + Worktree Diff / 接受应用 |
| 运维 | 队列护栏、备份、托盘、Doctor、自动化 |

### 文档工作流（报告 / 论文）

导航 **「文档工作流」**（`#/documents`）或 `/api/document-workflow/*`。

```text
创建文档任务 → Zotero 收集文献 → 提纲批准 → 分章写作 + Citation Map
→ OfficeCLI 生成 DOCX → 审查 → Word / Zotero 动态引用 → 导出
```

细则见 `reports/document-workflow-tasks48-57.md`。

### 默认不会做

- 不把 API Key / GitHub Token 写入普通 JSON 或备份明文  
- 未确认方案 / 未验收不把任务标完成  
- 不自动 `git push`；恢复时不自动重放危险操作  
- 不直接改 Zotero 数据库  

---

## Requirements

- Windows 10/11  
- [Node.js](https://nodejs.org/) 20+  
- [Git](https://git-scm.com/)（GitHub clone 项目需要）  
- 可选：[Codex CLI](https://github.com/openai/codex)、[OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)、[Zotero](https://www.zotero.org/)、Word/WPS + Zotero 插件  

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `PAW_SERVICE_PORT` | 服务端口 | `41731` |
| `PAW_DATA_DIR` | 数据目录 | `%LOCALAPPDATA%\PersonalAIWorkbench` |
| `PAW_WEB_DIST` | 同域托管前端 dist | — |
| `PAW_OFFICECLI_PATH` | OfficeCLI 路径 | PATH / 探测 |

---

## 从 Clone 到使用

### 1. 克隆

```powershell
cd D:\dev
git clone https://github.com/Logikinet/workbench.git
cd workbench
```

必须在**仓库根**（有根级 `package.json`、`apps/`）执行后续命令。

### 2. 安装

```powershell
npm install
```

### 3. 启动（推荐）

```powershell
npm run build --workspace=@paw/web
$env:PAW_WEB_DIST = (Resolve-Path "apps\web\dist").Path
npm run dev --workspace=@paw/service
```

浏览器：http://127.0.0.1:41731  

健康检查：

```powershell
curl http://127.0.0.1:41731/api/health
```

### 4. 或开发双进程

```powershell
npm run dev
```

打开 Vite 打印的地址；API 仍为 `41731`。

### 5. 构建 / 测试

```powershell
npm run build
npm test
npm run typecheck
npm run release-gate
```

### 6. Windows 安装包（可选）

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Install-PersonalAIWorkbench.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

| 路径 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\PersonalAIWorkbench` | 程序 |
| `%LOCALAPPDATA%\PersonalAIWorkbench` | 数据（含 `github-clones`、状态） |

### 7. CLI（Provider）

服务起来后：

```powershell
npm run pawb -- health
npm run pawb -- provider add
npm run pawb -- provider list
```

也可用仓库根 `.\pawb.cmd …`（勿把 API Key 当参数明文传入）。

### 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| 界面像假壳 / 502 | 用 `PAW_WEB_DIST` + `41731`，不要单独依赖坏掉的 5173 |
| 服务离线 | 确认 service 在跑；`curl http://127.0.0.1:41731/api/health` |
| 创建项目无仓库 | 设置 › GitHub 先关联 PAT；本机需 `git` |
| clone 失败 | 检查 Token 的 `repo` 权限与网络 |
| 端口占用 | 改 `PAW_SERVICE_PORT` 或结束占用 41731 的进程 |

---

## 仓库结构

```text
apps/
  service/     # Express Agent Service（含 github/ 绑仓、runs 用量等）
  web/         # PWA（todos 壳：总管 / 项目板 / 成员 / 模型…）
  cli/         # pawb CLI
  tray/        # 托盘
packaging/windows/
docs/          # PRODUCT、todos 对照研究
HOW_TO_RUN.md  # 最短跑通说明
scripts/e2e/
reports/
```

## Scripts

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | service + web 开发 |
| `npm run build` | 构建 service / web / tray / cli |
| `npm test` | 测试 |
| `npm run typecheck` | TS 检查 |
| `npm run pack:windows` | Windows 安装脚本 |
| `npm run release-gate` | 发布门禁 |
| `npm run pawb -- …` | 本机 CLI |

---

## 已知依赖本机环境

- 真实 OpenAI 兼容 API Key  
- 可选 Codex 登录、OfficeCLI / Zotero / Word  
- GitHub PAT + 本机 Git（项目绑仓）  

单元 / 合同测试与 `npm run release-gate` 覆盖安全路径与 Fake 依赖。

---

## License / 维护

私有工作台仓库；本机数据默认在 `%LOCALAPPDATA%\PersonalAIWorkbench`。卸载安装包时数据默认保留。
