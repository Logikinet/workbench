# 全功能任务续接（17–47）

更新：2026-07-15（自动推进）

## 已完成并本地提交 `c898dc9`

17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 35, 39

批回归 21–24：typecheck OK；相关 **80 tests / 12 files pass / 4.4s**（日志 `test-logs/batch-21-24-regression.txt`）

## 已完成（待本地提交）

- **28** Independent LLM Reviewer — `apps/service/src/review/`（结构化+Markdown 审查报告；独立模型；前置规则硬门禁；不可用暂停）。测试：**23 / 2 files pass**。

## 当前并行（互不撞文件）

| 任务 | 目录 |
| --- | --- |
| 36 | firstmate/ |
| 37 | agentHome/ |
| 41 | sessions/ |
| 43 | automation/ |

## NextClaw

- 包：`E:\Downloads\NextClaw-Portable-0.0.220-win-x64.zip`
- 解压：`%TEMP%\nextclaw-extract\app`（含 MCP SDK、Runtime 健康守护、launcher 更新）
- 文档：`docs/nextclaw-reference/README.md`

## 测试策略

- 单任务：仅相关 vitest 路径；成功只记摘要；完整日志 `test-logs/`
- 批后：受影响范围回归
- 全量：阶段/架构/任务 47 终验

## 未开始

29, 30, 31, 32, 33, 34, 38, 40, 42, 44, 45, 46, 47

## 规则

不 push；开发中
