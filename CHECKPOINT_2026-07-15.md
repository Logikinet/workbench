# Personal AI Workbench — 暂停检查点（2026-07-15）

## 可直接交付的进度

- 任务 01–10：已完成。任务 10 已完成 TDD、全量验证、生产构建和最终双轴审查。
- 任务 11：进行中，**未完成、未通过最终审查**。
- 任务 12–16：尚未开始；用户已明确要求不要开始它们。

## 任务 11 当前已写入的内容

- 新增 `apps/service/src/git/gitWorktreeService.ts`：Git Worktree 会话、主工作区脏状态阻断、Diff、验证结果持久化和放弃 Worktree。
- Codex CLI 的 Git Project 路径已开始接入隔离 Worktree；PWA/HTTP 已开始提供 Diff、验证和放弃入口。
- Secondmate 计划已开始携带 `verificationCommands`，HTTP 会按已批准计划校验命令。
- 已开始补强：Git 真正子命令调用、基线提交、NUL 路径解析、嵌套 Project 相对路径、输出脱敏、停止期间 Worktree 创建保护。

## 当前不能视为完成的原因

最新一轮 Task 11 双轴审查仍有未收尾问题；最近一次定向测试在修复中被中断，因此**不要把当前工作区当成全绿版本**。

恢复后按以下顺序继续：

1. 先运行定向测试，修正现有 Worktree 测试中仍期望 `git worktree add ... HEAD` 的旧断言，使其使用已保存的 `baselineCommit`。
2. 修复停止竞态：Worktree 创建等待期间用户停止时，只能清理“本次刚创建”的 Worktree，绝不能删除已有未验收 Worktree。
3. 序列化 `runApprovedChecks` 与 `discard`：验证运行中必须拒绝放弃，放弃/停止状态也必须拒绝新验证；PWA 按该状态禁用按钮。
4. 对 API Professional Agent 的代码任务执行边界做 fail-closed 收口，确保任何生产装配遗漏都不会直接写入主工作区。
5. 完成真实临时 Git 仓库集成测试：Worktree 创建/放弃、基线提交后的 diff、已暂存/已提交/未跟踪文件、嵌套目录、中文及带空格路径、验证命令 cwd 与脱敏。
6. 验证或迁移 Git Worktree 状态 schema v1→v2；当前实现已改为安全拒绝旧状态，但测试和恢复说明尚未完成。
7. 重新运行：`npm test`、`npm run typecheck`、`npm run build`。
8. 对任务 11 重新执行 Spec 与 Standards 双轴 code review；两轴均为 `✅OK` 后，才允许开始任务 12。

## 最近可靠验证基线

- 在任务 11 最后一轮审查修复前，已通过：16 个测试文件、94 项测试、类型检查和生产构建。
- 此后对任务 11 的审查发现进行了继续修改；这些最新修改尚未完成全量验证和最终复审。

## 恢复命令

```bash
cd personal-ai-workbench
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm test -- --run apps/service/src/git/gitWorktreeService.test.ts apps/service/src/codex/codexCliService.test.ts apps/service/src/http/gitWorktreeRoutes.test.ts
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm test
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm run typecheck
env -u NPM_CONFIG_CACHE NPM_CONFIG_CACHE=/tmp/paw-npm-cache npm run build
```

## 不要做

- 不要开始任务 12–16。
- 不要回退任务 01–10。
- 不要放宽 Codex 的 Project/workspace、网络、外发、日志脱敏、终止确认或写入会话确认边界。
- 不要把 `--ask-for-approval never` 改回 `on-request`。
- 不要提交代码或创建外部 Issue。
