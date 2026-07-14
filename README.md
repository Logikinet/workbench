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

- 服务：`http://127.0.0.1:41731`（仅本机）
- 前端：Vite 开发服务器（`apps/web`）

## Build & test

```bash
npm run build
npm test
npm run typecheck
```

文档工作流定向测试示例：

```bash
npx vitest run apps/service/src/officecli apps/service/src/zotero apps/service/src/documentWorkflow
```

可选发布门禁（不依赖真实 API Key / Codex / OfficeCLI / Zotero 登录）：

```bash
npm run release-gate
```

## Windows install (optional)

```powershell
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\Install-PersonalAIWorkbench.ps1
```

| Path | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\Programs\PersonalAIWorkbench` | 程序 |
| `%LOCALAPPDATA%\PersonalAIWorkbench` | 数据（卸载默认保留） |

托盘：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\TrayHost.ps1
```

## Usage

1. 启动：`npm run dev` 或安装后用托盘启动服务。
2. 在界面配置 OpenAI 兼容模型连接（Key 存凭据管理器）。
3. 创建 Project，授权本机工作目录。
4. 创建 Todo → 查看并批准计划 → 系统自动调度执行（也可手动启动代理）。
5. 查看时间线、Diff、审查报告 → 验收交付物；代码修改可「接受应用」或「放弃」。

### 写报告 / 论文

1. 启动 Zotero（本机 API）与可选 OfficeCLI。
2. 打开 PWA → **文档工作流**。
3. 填写 Project 工作区绝对路径、题目、任务要求、Zotero Collection、引用模式（动态 / 静态）。
4. 按步骤：收集文献 → 生成并**批准提纲** → 分章写作 → 生成 DOCX → 审查 → 引用定稿 → 导出。
5. 用 Word 打开草稿，插入/刷新 Zotero 动态引用后保存；回到工作台「刷新文件状态」登记人工版本。

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
