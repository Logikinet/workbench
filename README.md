# Personal AI Workbench

Windows 本地个人 AI 工作台。把 Todo 交给代理：先出计划、你批准后再在本机执行；可调研、写论文/报告、做课设、改代码；做完经独立审查，再由你验收。服务只监听 `127.0.0.1`，不暴露到公网。

## What it can do

### 从交任务到交成果

1. **新建 Todo** — 例如调研课题、写课程论文、做课设 demo、修 bug。
2. **先看计划再批准** — 拆步骤、验收标准与风险；批准前不改正式文件。
3. **本机自动执行** — 在你授权的项目目录里读资料、写文档、改代码；代码类任务可用 Codex + Git Worktree 隔离修改。
4. **独立审查 + 你验收** — 审查不过可自动修一轮；你确认后才算完成。
5. **可中途介入** — 暂停、停止、纠偏；危险操作需确认；中断后可按检查点恢复。

### 典型场景

| 场景 | 能力 |
| --- | --- |
| 调研 | 证据优先的检索与摘录，产出 `research.md` / 来源清单 |
| 论文 / 报告 | 文档工作流：Zotero 真实文献 → 提纲批准 → 分章撰写 → OfficeCLI 生成 DOCX → 审查 → Word 终排版 |
| 课设 / 大作业 | 任务书拆解、评分点映射、测试证据、交付 ZIP |
| 写代码 | API 工具循环或 Codex CLI；Diff、验证、接受/放弃 Worktree |
| 多项目管理 | Project + Todo 看板 + Run 历史 |
| 本机运维 | 队列与资源护栏、备份迁移、托盘启停、Doctor / 自动化触发 |

### 文档工作流（报告 / 论文）

PWA 导航 **「文档工作流」**（`#/documents`），或调用 `/api/document-workflow/*`。

```text
创建文档任务
→ 从本机 Zotero 收集文献（只读本地 API，不改 sqlite）
→ Secondmate 生成提纲 → 你批准
→ 分章写作 + Citation Map（结论绑定 Zotero Item Key）
→ OfficeCLI 生成/局部修改 DOCX（workspace 内、batch 失败可回滚）
→ 内容 / 引用 / 格式审查
→ Word 打开 + 动态引用（推荐）或静态引用
→ 检测人工保存 → 导出 DOCX / 引用清单 / 审查报告
```

职责划分：

| 组件 | 职责 |
| --- | --- |
| 模型代理 | 框架、撰写、润色、审查建议 |
| Zotero | 真实文献、元数据、全文索引（只读） |
| OfficeCLI | DOCX 创建、结构读取、批量修改、预览 |
| Word + Zotero 插件 | 动态引用、最终排版（人工） |

安全约定：

- 禁止虚构参考文献；未验证的 Item Key 不能进入引用清单
- 提纲未批准不能生成最终 DOCX
- OfficeCLI 仅 argv 参数、路径限制在 Project 工作区；动态引用插入后禁止破坏 Zotero 字段的全量重写
- 原始模板只读；人工修改登记为旁路版本，不覆盖用户保存

更细的任务单与真机验收项见 `reports/document-workflow-tasks48-57.md`。

### 不会默认做的事

- 不把 API Key 写入普通配置或备份（Windows 凭据管理器）
- 不在未批准计划 / 未审查验收时把任务标成完成
- 不自动 `git push`；恢复任务时不自动重放危险操作
- 不直接修改 Zotero 数据库；不替代完整 Word 编辑器

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+
- Git
- 可选：[Codex CLI](https://github.com/openai/codex)（代码隔离执行）
- 可选：[OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（报告/论文 DOCX 自动化）
- 可选：[Zotero](https://www.zotero.org/) 桌面端并开启本地 API（默认 `http://127.0.0.1:23119/api`）
- 可选：Microsoft Word / WPS + Zotero 插件（动态引用与终排版）

可通过环境变量覆盖 OfficeCLI 路径：

| Variable | Description |
| --- | --- |
| `PAW_OFFICECLI_PATH` | `officecli` 可执行文件绝对路径 |

## 详细使用步骤（从 Clone 到日常使用）

以下命令均在 **Windows** 上执行。推荐使用 **PowerShell** 或 **Windows Terminal**。  
**工作目录始终是仓库根目录**（clone 后名为 `workbench` 的那一层，里面有根级 `package.json`、`apps/`、`README.md`）。

### 0. 准备环境

1. 安装 [Node.js 20+](https://nodejs.org/)（安装后新开终端，执行 `node -v`、`npm -v` 确认可用）。
2. 安装 [Git](https://git-scm.com/)。
3. （可选）安装 [Codex CLI](https://github.com/openai/codex) — 写代码隔离执行。
4. （可选）安装 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — 论文/报告 DOCX。
5. （可选）安装 [Zotero](https://www.zotero.org/) 桌面端，并允许本机其他应用通过本地 API 访问（默认端口 `23119`）。
6. （可选）安装 Microsoft Word / WPS + Zotero 插件 — 动态引用与终排版。

### 1. 克隆仓库

在任意你有写权限的目录打开终端，例如 `D:\dev`：

```powershell
cd D:\dev
git clone https://github.com/Logikinet/workbench.git
cd workbench
```

此时当前目录应为：

```text
D:\dev\workbench\          ← 你必须在这里执行后续 npm 命令
  package.json
  apps\
  packaging\
  README.md
  ...
```

确认：

```powershell
Get-Location
# 应显示 ...\workbench
dir package.json
# 应能看到根目录 package.json
```

若你 clone 到了别的盘，只要 `cd` 进该仓库根目录即可，路径不限。

### 2. 安装依赖

仍在 **仓库根目录** `workbench`：

```powershell
npm install
```

首次安装可能较久。成功后根目录会出现 `node_modules\`（workspaces 会装 `apps/*`）。

### 3. 开发模式启动（推荐第一次试用）

仍在 **仓库根目录**：

```powershell
npm run dev
```

该命令会同时启动：

| 进程 | 说明 | 默认地址 |
| --- | --- | --- |
| Agent Service | 后端（Express，仅本机） | `http://127.0.0.1:41731` |
| Web（Vite） | 前端开发服务器 | 终端里打印的本地地址（常见为 `http://127.0.0.1:5173`） |

保持该终端窗口运行，不要关闭。

### 4. 打开界面

1. 用浏览器打开 Vite 提示的前端地址（例如 `http://127.0.0.1:5173`）。
2. 顶部服务状态应变为在线（会请求 `http://127.0.0.1:41731/api/health`）。
3. 若显示离线：确认 `npm run dev` 仍在运行，且端口 `41731` 未被占用。

可选健康检查（另开一个终端即可，不必在仓库目录）：

```powershell
curl http://127.0.0.1:41731/api/health
```

### 5. 首次配置（界面内）

1. 打开左侧 **Connections**（连接）。
2. 添加 OpenAI 兼容模型连接，填入 Base URL / Model；API Key 写入 **Windows 凭据管理器**，不会进普通配置文件。
3. 打开 **Projects**，创建 Project，授权本机某个**真实工作目录**（例如 `D:\projects\my-paper`）。后续代理只能在该目录边界内工作。
4. 按需检查 **Agents / Roles**（Firstmate、执行代理、Reviewer 等）。

### 6. 日常：Todo 闭环（调研 / 课设 / 改代码）

1. 左侧进入 **Todos**。
2. 新建 Todo，写清目标（例如「修复登录超时」「写课设 demo」）。
3. 等待 / 触发生成计划 → 在计划面板核对步骤与验证命令 → **批准计划**。
4. 批准后系统可自动创建子任务并启动执行代理（也可手动点执行）。
5. 在 Run 时间线查看日志、Diff、审查结果。
6. 代码任务：在 Worktree 面板查看 Diff → 验证 → **接受应用** 或 **放弃**（不会自动 `git push`）。
7. 审查通过后，由你 **验收**，Todo 才算完成。

### 7. 日常：报告 / 论文（文档工作流）

1. 启动本机 **Zotero**（需要读文献时）；需要自动写 DOCX 时确认 **OfficeCLI** 在 PATH 或设置了 `PAW_OFFICECLI_PATH`。
2. 浏览器打开工作台，左侧进入 **文档工作流**（地址也可为 `#/documents`）。
3. 填写：
   - **工作区路径**：Project 的绝对路径（与 Projects 里授权的目录一致，例如 `D:\projects\my-paper`）
   - 题目、任务要求、文档类型
   - 引用模式：动态 Zotero（推荐）或静态
   - （可选）Zotero Collection
4. 按页面按钮顺序执行：
   1. 创建文档任务  
   2. 收集 Zotero 文献  
   3. 生成提纲  
   4. **批准提纲**（未批准不能写正文 / 生成终稿）  
   5. 分章写作  
   6. OfficeCLI 生成 DOCX  
   7. 审查  
   8. 引用定稿 → 导出清单与报告  
5. 用 Word 打开生成的 DOCX，插入/刷新 Zotero 动态引用并排版保存。
6. 回到工作台点 **刷新文件状态**，登记人工版本。

产物一般在工作区下：

```text
<你的 Project 目录>\
  .workbench\document-runs\<jobId>\   # 提纲、草稿、manifest、预览
  artifacts\                          # DOCX、引用清单、审查报告等
```

### 8. 停止开发服务

在运行 `npm run dev` 的终端按 `Ctrl+C` 结束。

### 9. 构建、测试（可选）

仍在 **仓库根目录** `workbench`：

```powershell
# 全量 TypeScript 检查
npm run typecheck

# 全量测试
npm test

# 构建 service + web + tray
npm run build

# 文档工作流相关定向测试
npx vitest run apps/service/src/officecli apps/service/src/zotero apps/service/src/documentWorkflow

# 发布门禁（不依赖真实 Key / Codex / OfficeCLI / Zotero）
npm run release-gate
```

### 10. 安装为 Windows 本机程序（可选）

仍在 **仓库根目录**，先构建再安装：

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Install-PersonalAIWorkbench.ps1
```

| 路径 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\PersonalAIWorkbench` | 程序文件 |
| `%LOCALAPPDATA%\PersonalAIWorkbench` | 数据（卸载默认保留） |

用托盘托管服务（安装后常用）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

托盘启动后，浏览器访问安装脚本 / 托盘提示的本机地址（服务仍为 `127.0.0.1`，默认端口 `41731`）。

### 11. 常用命令速查

所有 `npm` 命令都在 **仓库根目录** 执行：

| 你想做什么 | 进入目录 | 命令 |
| --- | --- | --- |
| 第一次拿到代码 | 任意 → `cd workbench` | `git clone ...` 然后 `cd workbench` |
| 装依赖 | `workbench` | `npm install` |
| 开发启动 | `workbench` | `npm run dev` |
| 构建 | `workbench` | `npm run build` |
| 测试 | `workbench` | `npm test` |
| 类型检查 | `workbench` | `npm run typecheck` |
| 本机安装包脚本 | `workbench` | `npm run pack:windows` 或上面的 `Install-...ps1` |
| 更新代码 | `workbench` | `git pull` 然后必要时再 `npm install` |

### 12. 环境变量（可选）

在启动服务前设置（PowerShell 当前会话示例）：

```powershell
$env:PAW_SERVICE_PORT = "41731"
$env:PAW_DATA_DIR = "$env:LOCALAPPDATA\PersonalAIWorkbench"
$env:PAW_OFFICECLI_PATH = "C:\Path\To\officecli.exe"
# 若已构建前端并希望 service 同域托管 PWA：
# $env:PAW_WEB_DIST = "D:\dev\workbench\apps\web\dist"
npm run dev
```

### 13. 故障排查简表

| 现象 | 处理 |
| --- | --- |
| `npm` 不是内部或外部命令 | 安装 Node.js 并**重开终端** |
| 界面显示服务离线 | 确认根目录已 `npm run dev`；访问 `http://127.0.0.1:41731/api/health` |
| 端口被占用 | 改 `PAW_SERVICE_PORT` 或结束占用 41731 的进程 |
| Zotero 收集失败 | 打开 Zotero 桌面端，确认本地 API 可访问 |
| OfficeCLI 生成失败 | 安装 OfficeCLI 或设置 `PAW_OFFICECLI_PATH`；确认工作区路径是绝对路径 |
| 依赖装完仍报模块缺失 | 在根目录重新 `npm install`，不要只在 `apps/web` 里装 |

---

## Install（精简）

```powershell
git clone https://github.com/Logikinet/workbench.git
cd workbench
npm install
```

## Development（精简）

```powershell
# 必须在仓库根目录 workbench
npm run dev
```

- 服务：`http://127.0.0.1:41731`（仅本机）
- 前端：Vite 打印的本地地址（见终端输出）

## Build & test（精简）

```powershell
npm run build
npm test
npm run typecheck
```

文档工作流定向测试：

```powershell
npx vitest run apps/service/src/officecli apps/service/src/zotero apps/service/src/documentWorkflow
```

发布门禁：

```powershell
npm run release-gate
```

## Windows install（精简）

见上文 **§10**。托盘：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

## Usage（精简）

完整步骤见 **「详细使用步骤」**。摘要：

1. 根目录 `npm run dev` → 浏览器打开 Vite 地址。
2. Connections 配置模型 → Projects 授权工作目录。
3. Todos：批准计划 → 执行 → 审查 → 验收。
4. 文档工作流：填工作区绝对路径 → 收集文献 → 批准提纲 → 写作 → DOCX → 审查 → Word 终排版。

## Project structure

```text
apps/
  service/     # 本地 Agent Service（Express）
    officecli/           # OfficeCLI Runtime Adapter
    zotero/              # Zotero 本地只读 Connector
    documentWorkflow/    # 报告/论文流水线
  web/         # PWA 前端（含文档工作流页）
  tray/        # 托盘与进程管理
packaging/
  windows/     # 安装 / 升级 / 卸载脚本
scripts/
  e2e/         # 发布门禁
reports/       # 验收报告输出
docs/
  nextclaw-reference/  # 架构参考说明（非依赖）
```

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `PAW_SERVICE_PORT` | 服务端口 | `41731` |
| `PAW_DATA_DIR` | 数据目录 | `%LOCALAPPDATA%\PersonalAIWorkbench` |
| `PAW_WEB_DIST` | 同域托管的前端构建目录 | — |
| `PAW_OFFICECLI_PATH` | OfficeCLI 可执行文件路径 | PATH / 常见安装位置探测 |

模型、Role、队列、备份、MCP、文档任务等在应用界面中配置。

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | 开发模式启动 service + web |
| `npm run build` | 构建 service、web、tray |
| `npm test` | 运行测试 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run pack:windows` | 运行 Windows 安装脚本 |
| `npm run release-gate` | CI 安全路径的发布门禁检查 |

## Known residual risks

发布门禁与单元/合同测试覆盖安全路径与 Fake 依赖。日常完整使用仍依赖本机环境，包括：

- 真实 OpenAI 兼容 API Key
- 真实 Codex 登录（代码任务）
- 真实 OfficeCLI / Zotero / Word 插件（论文动态引用闭环）
- 干净 Windows 安装与凭据管理器

详见 `reports/document-workflow-tasks48-57.md` 与 `reports/final-acceptance-task47.md`。

## License

仓库暂未附带 `LICENSE`。若需开源分发，请自行补充许可证文件。
