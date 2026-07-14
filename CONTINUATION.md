# Personal AI Workbench — 续接检查点

创建时间：2026-07-13（Asia/Tokyo）

## 当前目标

按已确认任务单完成本地 Windows PWA + Node.js Agent 工作台。执行顺序、TDD、验证与双轴 code review 都必须保留；不创建外部 Issue、不提交代码、不顺手修改无关内容。

当前正处于 **任务 11：代码任务的 Worktree、测试和 Diff 闭环**。任务 12–16 尚未开始，必须等待任务 11 完整通过测试、构建和复审后再继续。

## 已完成

以下任务均已完成，并在进入下一任务前完成过 TDD、验证和双轴审查：

| 任务 | 状态 | 核心交付 |
| --- | --- | --- |
| 01 | 完成 | 本地 PWA、仅 loopback 的 Express 服务、离线基础能力。 |
| 02 | 完成 | Project CRUD、Windows 工作目录授权、路径/符号链接边界。 |
| 03 | 完成 | Todo CRUD、检索筛选、看板。 |
| 04 | 完成 | Run、时间线、日志、审查、成果与批准记录。 |
| 05 | 完成 | OpenAI 兼容连接、Windows Credential Manager、连接失败暂停。 |
| 06 | 完成 | Agent Role、Harness、Skill/Tool/权限配置，Firstmate 保护。 |
| 07 | 完成 | Firstmate 评估、Secondmate 计划、版本历史与批准门禁。 |
| 08 | 完成 | API Professional Agent、受限文件写入、临时 Role、失败/重试。 |
| 09 | 完成 | 权限门禁、暂停/停止、危险操作确认、纠偏、并发与重试保护。 |
| 10 | 完成 | Codex CLI Harness、受限写入会话确认、日志脱敏、可靠终止与本机登录状态处理。 |

## 任务 10 最终验证

### 已实现并已有测试覆盖的部分

- `CodexCliService`：检测 `codex --version` 与 `codex login status`，不暴露凭据。
- Codex CLI Role：要求 `codex-cli`、`filesystem`、`shell` 工具及 `implement` Skill；拒绝不符合的 Role。
- 从已批准 Run 的 Project 工作目录启动 Codex，并使用 `--cd`、`--skip-git-repo-check` 支持非 Git 项目。
- CLI 标准输出/错误输出实时写入 Run 时间线，并进行敏感信息脱敏（连接串、Token、Authorization、Cookie、PEM 等）。
- Stop 使用启动占位避免孤儿进程；Node 运行时采用 POSIX 进程组终止/超时升级，Windows 使用 `taskkill /T /F` 并等待退出确认。
- 终止确认失败会把 Run 固化为暂停状态，禁止后续 Stop 假装取消或继续执行。
- 非交互 Codex 使用 fail-closed 沙箱配置：网络关闭、临时目录不可写、无额外 writable roots；网络/外发权限的 Codex Role 由服务端拒绝。
- 运行期间认证失败会根据脱敏 stderr 和登录复检给出 `codex login` 指引；PWA 在后端返回 paused 时不再误报“已启动”。
- 已新增 Codex HTTP、PWA client 和 Role/Harness 界面入口。

### 最终补强

为满足任务 09 的“删除必须确认”边界，刚加入 **Codex 写入会话的显式预确认**：

1. 首次启动 Codex Role 时，服务先把 Run 暂停为 `delete_file` 类型的待确认审批；
2. 用户在 PWA 中确认后，才允许下一次受控重试真正 spawn Codex；
3. 因 Codex CLI 采用非交互模式，不能安全地把单个删除操作伪装成可交互审批，所以该预确认覆盖本次整个 Project 写入会话。

写入会话确认已通过 SHA-256 指纹绑定到已批准计划、Role 配置与最终执行提示；重大纠偏或 Role/提示变化不能复用旧确认。已补充 signalCode 终止检测，避免已被信号终止的子进程误报为“终止未确认”。

## 检查点验证

- `npm test`：14 个测试文件、86 项测试全部通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- 最终双轴 code review：Spec `✅OK`；Standards `✅OK`。

## 当前问题 / 未完成项

1. 任务 11 已新增 `apps/service/src/git/gitWorktreeService.ts` 与测试：能在干净 Git 主工作区创建 detached Worktree、读取完整 Diff/文件列表、持久记录验证结果、放弃 Worktree。
2. Git Project 的 Codex Run 已在“写入会话确认后、spawn 前”创建 Worktree 并将 CLI cwd 切至隔离目录；脏工作区或创建失败会暂停 Run。非 Git Project 保留任务 10 已验证的主工作区执行路径。
3. 已新增本地 HTTP：读取 Diff、运行隔离检查、放弃 Worktree；PWA 已能展示完整 Diff/修改文件并允许放弃修改。相关定向测试（20 项）和 `npm run typecheck` 通过。
4. 下一步：将验证命令明确绑定到获批准的 Secondmate 计划，而非任意 HTTP 输入；随后运行任务 11 的完整 TDD 回归、全量验证与双轴 code review。
4. 任务 11 完成前，不启动任务 12–16。

## 已确认约束

- 产品为 Windows 本地个人工作台：PWA + 本地 Node.js 服务；首版不做多用户或云同步。
- 主闭环：Todo → Firstmate 识别/编排 → Secondmate 计划 → 用户批准 → 执行 → 审查 → 验收。
- Project 工作区白名单边界不能弱化；禁止绕过 `.env`/密钥、网络、Git push/deploy 等安全限制。
- 每张任务单单独完成：TDD → 必要验证 → code review，且不可跳过。
- 不提交代码，不创建外部 Issue。
- 真实 Codex CLI 在当前环境未安装；实现用可注入 Fake Runtime 测试了安装/登录/执行/停止/失败路径。真实 Windows CLI 登录执行需在后续目标机器验证。

## 不要修改

- 不回退或重写已完成的 01–09；它们是任务 10 的依赖基础。
- 不放宽 Codex CLI 的 workspace、网络、外发、日志脱敏或终止确认边界。
- 不把 `--ask-for-approval never` 误改回 `on-request`：当前 Harness 是非交互 stdin 模式，没有审批事件桥。
- 不删除本文件；它是下次续接的状态块。

## 关键文件

- 任务单：`../personal-ai-workbench-tickets/issues/`
- 任务 10 实现：`apps/service/src/codex/codexCliService.ts`
- 任务 10 测试：`apps/service/src/codex/codexCliService.test.ts`
- Run 状态/终止保护：`apps/service/src/runs/runService.ts`
- HTTP：`apps/service/src/http/app.ts`、`apps/service/src/http/codexCliRoutes.test.ts`
- PWA：`apps/web/src/components/CodexHarnessPanel.tsx`、`ProfessionalAgentPanel.tsx`、`RolesPanel.tsx`、`apps/web/src/lib/runs.ts`
- 审查快照（如果仍在临时环境）：`/tmp/paw-review/after-09-final.tar`

## 续接命令

```bash
cd /path/to/personal-ai-workbench
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm test
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm run typecheck
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm run build
```

先从“当前问题 / 未完成项”第 1 项开始，不要直接开启任务 11。
