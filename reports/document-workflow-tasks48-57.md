# Document Workflow Tasks 48–57 实现与验收说明

日期：2026-07-15  
方案：`OfficeCLI + Zotero 报告论文工作流方案.md`

## 已完成任务

| 任务 | 内容 | 验证 |
|------|------|------|
| 48 | OfficeCLI Runtime Adapter（探测、create、batch 备份回滚、preview、validate、cancel、日志脱敏） | `officeCliRuntime.test.ts` |
| 49 | Zotero Local Connector（本地 API only，禁止 SQLite；Collection/Item/全文/Evidence seed） | `zoteroConnector.test.ts` |
| 50 | DocumentJob 状态机与领域模型 | `documentWorkflowTypes` + service 测试 |
| 51 | 提纲生成/批准、分章写作、未批准禁止写作 | service 测试 |
| 52 | OfficeCLI 生成 DOCX、operations 计划、模板复制路径 | service 测试（Fake runner） |
| 53 | Citation Map、动态 `{{ZOTERO:KEY}}` / 静态模式、Item Key 核验 | service 测试 |
| 54 | 内容/引用/格式审查闭环 | service 测试 |
| 55 | 文件哈希变更检测、人工版本登记、导出 PDF 占位与引用清单 | service 测试 |
| 56 | HTTP 路由 + PWA「文档工作流」页面 | routes 测试 + UI 挂载 |
| 57 | 终验说明与残余风险（见下） | 本报告 |

## 主要改动路径

- `apps/service/src/officecli/*`
- `apps/service/src/zotero/*`
- `apps/service/src/documentWorkflow/*`
- `apps/service/src/main.ts` / `http/app.ts` 生产挂载
- `apps/web/src/components/DocumentWorkflowPanel.tsx`
- `apps/web/src/lib/documentWorkflow.ts`
- 导航路由 `#/documents`

## 安全边界（已编码）

- OfficeCLI 仅 argv 数组，路径必须在 Project workspace 内
- batch 前备份，失败恢复
- 动态引用存在时拒绝 unsafe 全量操作
- Zotero 只读本地 HTTP API，拒绝 sqlite 路径
- 未验证 Item Key 不得进入引用清单
- 提纲未批准不得 `generateDocx` / 写作
- 不覆盖原始模板；人工版本复制旁路保存

## 自动化验证

```text
npx vitest run apps/service/src/officecli apps/service/src/zotero apps/service/src/documentWorkflow
```

（实现时本地已通过定向测试；推送前请再跑一遍。）

## 任务 57：真实 Windows E2E 残余风险（未在 CI 中伪造）

以下必须在装有真实依赖的 Windows 机器上人工/半自动验收：

1. 真实 OfficeCLI 安装与 `create` / `batch` / `view`
2. 真实 Zotero 桌面端本地 API（`127.0.0.1:23119`）与测试 Collection
3. 真实 Word + Zotero 插件动态引用刷新
4. 真实模板 DOCX 局部修改与失败回滚
5. 真实 PDF 导出（当前自动化使用占位文件，避免伪造成功）
6. Word 占用文件时的写保护 / 用户保存检测
7. 服务重启后 `document-jobs.json` 与 run 目录恢复

**结论：** 模块与合同测试路径已打通；真实 OfficeCLI/Zotero/Word 闭环列为环境依赖验收，未标记为已在 CI 全绿。

## 使用入口

1. 启动服务后打开 PWA → **文档工作流**
2. 填写 Project 工作区绝对路径
3. 按页面步骤 1–8 执行，或调用 `/api/document-workflow/*`
