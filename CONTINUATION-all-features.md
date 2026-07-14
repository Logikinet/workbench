# 全功能任务续接（17–47）

更新：2026-07-15（自动推进中）

## 已完成

| 任务 | 状态 |
| --- | --- |
| 17 | ✅ model runtime |
| 18 | ✅ AI 默认规划 + 模板 fallback |
| 19 | ✅ AskUser / AskApproval / AskReplan |
| 20 | ✅ 角色路由（路由已挂载） |
| 25 | ✅ 项目感知验证（路由已挂载） |
| 26 | ✅ Codex artifact |
| 27 | ✅ Worktree apply |
| 35 | ✅ Runtime 协议 + 生产接线 |
| 39 | ✅ Provider/secrets |

## 进行中并行

- 21 子任务 DAG
- 22 Skills/Tools
- 23 API tool loop
- 24 MCP（参考 NextClaw 内 `@modelcontextprotocol/sdk`）

## NextClaw 参考

- 解压：`%TEMP%\nextclaw-extract\app`
- 说明：`docs/nextclaw-reference/README.md`
- 不采用渠道扩展；采用 Runtime 健康守护、MCP SDK、Extension 边界思路

## 验证基线

- 上一合并点：`npm test` **388 passed**，typecheck 通过

## 测试策略（强制）

1. **单任务**：只跑与本次变更直接相关的单元/集成测试 + 必要 typecheck；**禁止**每张任务后全量 `npm test`。
2. **成功摘要**：仅记录通过数、耗时；完整日志写入 `test-logs/`，不注入对话上下文。
3. **失败分析**：只读失败用例与堆栈。
4. **批回归**：一批有依赖关系的任务合并后，跑受影响范围回归。
5. **全量**：仅阶段验收、核心架构变更、或最终交付（任务 47）前执行。

## 规则

- 不 push；可本地中文 commit
- 47 前：开发中
