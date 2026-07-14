# TEMP — Task 40 Skill/MCP catalog lifecycle

**Status:** implemented (service modules only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/skills/**` and `apps/service/src/mcp/**`  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/skills apps/service/src/mcp` → **35 passed / 7 files**

## What shipped

Local Skill + MCP catalog lifecycle inspired by NextClaw source tiers / install inventory / trust gates — **no** third-party marketplace brand or network directory dependency.

### Skills (`apps/service/src/skills/`)

| File | Role |
| --- | --- |
| `skillTypes.ts` | Sources, install records, detail/preview/drift/update types, source priority map |
| `skillCatalog.ts` | Local catalog provider + search/hash/diff/permission helpers |
| `skillService.ts` | Install / update / drift / rollback / project dirs / detail |
| `skillRoutes.ts` | HTTP for catalog lifecycle (+ Task 22 routes) |
| `skillCatalogLifecycle.test.ts` | Task 40 TDD coverage |

**Source priority (conflict handling):**

`builtin (100) > project (80) > user_local/trusted_dir (60) > imported (50) > catalog (40)`

- Built-ins **never** silently overwritten by local or catalog packages.
- Project skills beat user-local; re-import of lower priority is skipped with conflict reason.
- Catalog install of a name that collides with builtin is blocked.

**Lifecycle capabilities:**

- [x] Distinguish builtin / user_local / project / catalog
- [x] Skill detail: description, version, source, permissions, file content, install status
- [x] Install inventory with version + content hash + rollback history
- [x] Drift detection before update; diff preview; forceDespiteDrift gate
- [x] Catalog search (query, tags, recommended); install requires `confirm: true`
- [x] Permission summary + trust record before first use (new install/update → untrusted)
- [x] Offline: catalog `isAvailable()===false` → empty search; installed skills still enable/trust/list

### MCP (`apps/service/src/mcp/`)

| File | Role |
| --- | --- |
| `mcpTypes.ts` | Catalog entry, install record, permission summary, `untrusted` call error |
| `mcpCatalog.ts` | Local MCP catalog seeds + search/diff helpers |
| `mcpService.ts` | Catalog install / trust / update / rollback; trust gate on `callTool` |
| `mcpRoutes.ts` | Catalog + trust + update/rollback HTTP |
| `mcpCatalogLifecycle.test.ts` | Task 40 TDD coverage |

**Lifecycle capabilities:**

- [x] Catalog search/filter/recommended; install requires `confirm: true`
- [x] Permission summary before trust; catalog installs start **untrusted**
- [x] `callTool` returns `kind: "untrusted"` until operator trusts
- [x] Per-tool Role bindings unchanged (whole server never default-exposed)
- [x] Version update from catalog + rollback history; update clears trust
- [x] Offline catalog does not block managing installed connections
- [x] Manual Task-24 connections remain trusted by default (compat)

## HTTP routes (module-owned)

### Skills (additions)

```
GET    /api/skills/catalog
GET    /api/skills/project-directories
GET    /api/skills/:skillId/detail
GET    /api/skills/:skillId/permissions
GET    /api/skills/:skillId/drift
GET    /api/skills/:skillId/update-preview
POST   /api/skills/project-directories
POST   /api/skills/catalog/preview-install
POST   /api/skills/catalog/install          body: { catalogId, confirm: true }
POST   /api/skills/:skillId/revoke-trust
POST   /api/skills/:skillId/update          body: { confirm: true, forceDespiteDrift? }
POST   /api/skills/:skillId/rollback        body: { confirm: true, version? }
```

### MCP (additions)

```
GET    /api/mcp/catalog
POST   /api/mcp/catalog/preview-install
POST   /api/mcp/catalog/install             body: { catalogId, confirm: true }
GET    /api/mcp/connections/:id/permissions
POST   /api/mcp/connections/:id/trust
POST   /api/mcp/connections/:id/revoke-trust
GET    /api/mcp/connections/:id/update-preview
POST   /api/mcp/connections/:id/update      body: { confirm: true }
POST   /api/mcp/connections/:id/rollback    body: { confirm: true, version? }
```

## Mount notes (out of ownership)

```ts
import { SkillService, createSkillRouter, LocalSkillCatalogProvider } from "../skills/index.js";
import { McpService, mountMcpRoutes, LocalMcpCatalogProvider } from "../mcp/index.js";

const skills = await SkillService.open({
  statePath: join(dataDirectory, "skills-state.json"),
  installRoot: join(dataDirectory, "installed-skills"),
  catalog: new LocalSkillCatalogProvider()
});
const mcp = await McpService.open({
  statePath: join(dataDirectory, "mcp-connections.json"),
  vault,
  catalog: new LocalMcpCatalogProvider()
});
app.use(createSkillRouter({ skills, capabilityRuntime }));
mountMcpRoutes(app, mcp);
```

## Intentionally not done

- Did **not** edit `apps/service/src/http/app.ts` or `main.ts` (parallel ownership).
- Did **not** build PWA UI for the catalog (service + routes only).
- No push; no full suite.
- No NextClaw marketplace brand/service coupling — local seeds only.

## Ticket checklist

- [x] 区分内置、用户本地、Project 专属和目录来源，并定义明确优先级与冲突处理
- [x] Skill 详情展示说明、版本、来源、权限需求、文件内容和安装状态
- [x] 安装记录来源与版本清单，更新前检测本地漂移，支持差异预览与回滚
- [x] 支持 Skill/MCP 目录搜索、标签筛选和推荐，但安装必须由用户确认
- [x] 新 Skill、MCP 或更新版本首次运行前显示权限摘要并建立信任记录
- [x] MCP Server 工具可按单个 Tool 绑定，不能默认将整个 Server 暴露给所有 Agent
- [x] 内置能力不可被同名未知本地文件静默覆盖
- [x] 离线状态下仍能管理已安装能力，不因目录服务不可用阻塞执行
