# Task 30 — Todos-style focused workbench UI

**Status:** implemented (web typecheck + lib tests green)  
**Ownership:** `apps/web/**` (App shell, nav, WaitingOnMe, mobile CSS)  
**Date:** 2026-07-15  
**No push.** Service APIs unchanged.

## What was built

Refactored the long vertical admin page into a **focused multi-section workbench**:

| Route | Content |
| --- | --- |
| `#/home` | Status counts + WaitingOnMe preview + quick links |
| `#/waiting` | Unified “等待我处理” center |
| `#/todos` / `#/todos/:todoId` | Todo board + focused Run detail timeline |
| `#/projects` | Projects panel |
| `#/agents` | Roles (capability/connection/auto-invoke/instance) + RoleRouter + Sessions |
| `#/connections` | Connections + MCP |
| `#/settings` | Queue guards + Backup + PWA install guide |

### Checklist

- [x] Independent nav: Todos, Projects, Todo/Run detail, Agents, Connections, Settings
- [x] Home counts: 待处理 / 运行中 / 等待用户 / 审查失败 / 待验收 / 已完成
- [x] Todo detail focused timeline: dialogue, plan, AskUser, subtasks, logs, Diff (worktree), review, artifacts
- [x] Unified WaitingOnMe: plan approval, AskUser, dangerous ops, final acceptance (+ review failed / recovery)
- [x] Agents page shows skills/tools, connection binding, Firstmate auto-invoke, enabled instance state
- [x] Mobile PWA: sticky horizontal nav, larger approve/AskUser hit targets; status + answer + approve/stop first-class
- [x] Keyboard: skip link, focus-visible nav, aria-current; loading/error states; log fold max 200 lines

### Key files

| Path | Role |
| --- | --- |
| `apps/web/src/App.tsx` | Hash-route shell, dashboard load, section mount |
| `apps/web/src/components/WorkbenchNav.tsx` | Side / mobile top nav + badge |
| `apps/web/src/components/HomeDashboard.tsx` | Status grid + waiting preview |
| `apps/web/src/components/WaitingOnMeCenter.tsx` | Filterable waiting center |
| `apps/web/src/lib/workbenchRoutes.ts` | Parse/format hash routes |
| `apps/web/src/lib/waitingOnMe.ts` | Pure count + waiting extraction |
| `apps/web/src/lib/workbenchDashboard.ts` | Client aggregation via existing list APIs only |
| `apps/web/src/components/TodoBoard.tsx` | Deep-link `focusTodoId` |
| `apps/web/src/components/RunTimelinePanel.tsx` | Subtask DAG + artifacts + log fold |
| `apps/web/src/components/RolesPanel.tsx` | Richer agent capability/status lines |
| `apps/web/src/styles.css` | Workbench layout + mobile CSS |

### Safety / API

- **No service route changes.** Dashboard scans `GET /api/todos` and per-todo `GET /api/todos/:id/runs` only for attention statuses, concurrency-capped at 4.
- Plan approve / AskUser / danger / acceptance still go through existing Run endpoints inside existing panels.
- Security semantics of approve/stop/accept unchanged.

### Tests / checks

```text
./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
# OK

npx vitest run apps/web/src/lib/workbenchRoutes.test.ts \
  apps/web/src/lib/waitingOnMe.test.ts \
  apps/web/src/lib/workbenchDashboard.test.ts \
  apps/web/src/lib/todos.test.ts
# 4 files, 13 tests passed
```

No full monorepo test. No push.
