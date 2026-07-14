# Task 36 — Firstmate self-management tools

**Status:** implemented (scoped tests green)  
**Ownership:** `apps/service/src/firstmate/**` only (did not edit `app.ts`)  
**Date:** 2026-07-15

## What was built

Firstmate AI Self-Management tool surface (NextClaw-inspired contract) so Firstmate can inspect and manage the workbench without secrets, silent global config edits, or raw DB access.

### Module layout

| File | Role |
| --- | --- |
| `firstmateTypes.ts` | Tool names, audit, temporary agent, discovery views, role schema |
| `firstmateSelfManagementService.ts` | Core service: Role CRUD, temporary agents, discovery, audit |
| `firstmateTools.ts` | Machine-readable tool catalog + `invokeFirstmateTool` |
| `firstmateRoutes.ts` | HTTP routes + `createFirstmateRouteApp` for tests (mount later) |
| `index.ts` | Public exports |
| `*.test.ts` | Scoped TDD (service + routes) |

### Checklist coverage

- [x] `list/get/create/update/remove` Agent Role tools; built-in Firstmate cannot be deleted (name match `/firstmate/i` or id `firstmate`)
- [x] Read-only discovery: Runtime, Connection, Skill, Tool, Project, Run, queue
- [x] Temporary agents: name, responsibility, avatar, runtime (harness), skills, tools, permissions
- [x] Config mutation workflow: **read → schema → minimal patch → re-read verify** (`roles.update` returns full cycle)
- [x] Long-term Role create/update/remove require `userRequested=true` (no silent global/long-term edits)
- [x] Machine-readable tool specs/schemas; no inventing enums or editing internal DB
- [x] Management ops write audit timeline (actor, reason, before/after/diff, result)
- [x] Secrets never returned (`listPublic`/`getPublic`; redaction on audit reason/text)

### Tool catalog (invoke surface)

`roles.list|get|schema|create|update|remove`  
`agents.temporary.create|list|get|remove`  
`runtimes.list|get` · `connections.list|get` · `skills.list|get` · `tools.list|get`  
`projects.list|get` · `runs.list|get` · `queue.status` · `audit.list|get`

### Mount (do not edit app.ts from this task)

```ts
import { createFirstmateRouter, FirstmateSelfManagementService } from "../firstmate/index.js";

const firstmate = new FirstmateSelfManagementService({
  roles, connections, skills, tools, projects, runs, queue, runtimes
});
app.use(createFirstmateRouter({ firstmate }));
```

### HTTP highlights

- `GET /api/firstmate/tools` — catalog + workflow notes  
- `POST /api/firstmate/tools/:toolName/invoke` — unified invoke  
- REST convenience under `/api/firstmate/roles`, `temporary-agents`, discovery paths, `/api/firstmate/audit`

## Tests

```text
npx vitest run apps/service/src/firstmate
# 2 files, 17 tests passed (~1.2s)
```

No full suite. No push.

## Out of scope / notes

- `app.ts` / main wiring left for integrator  
- Project/Run/queue clients optional; missing queue → 503 on `queue.status`  
- Temporary agents live in-memory on the service (run-scoped), not auto-saved to Role library  
- Firstmate protection is by name/id convention on existing `RoleService` records (no RoleService schema change; ownership limited to `firstmate/`)
