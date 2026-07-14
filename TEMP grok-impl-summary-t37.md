# Task 37 — Agent Home, profile, layered memory

**Status:** implemented (service module only; no HTTP wiring / no app.ts)  
**Ownership:** `apps/service/src/agentHome/**` only  
**Tests:** `npx vitest run apps/service/src/agentHome` → **16 passed** (scoped)

## Delivered

| Ticket item | Implementation |
| --- | --- |
| Long-term role Home isolation | `AgentHomeService.ensureLongTermHome(roleId)` → `{longTermRoot}/{roleId}/` |
| Profile files + `skills/` | Seeds `AGENTS.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `skills/`, `memory/` |
| Firstmate hard rules not overridable | `firstmateHardRules.ts` uses `roleService.firstmateCoreRules`; writes scanned; compose always system-prefixes |
| Layered memory, minimal load | Layers: `global_preferences`, `project_facts`, `task_checkpoints`, `role_experience` via `loadContext({ layers })` |
| Private memory not shared | `exportShared()` never includes MEMORY.md / private layers; `assertPrivateMemoryIsolated` |
| Memory source + inference gate | `writeMemory` requires `source`; uncertain phrasing cannot be stored as `fact` |
| Template migrate / edit / restore / diff | `CURRENT_TEMPLATE_VERSION=1`, `migrateHome`, `restoreDefaults`, `diffAgainstDefaults`, user `writeProfileFile` |
| Temporary homes | `createTemporaryHome` under `tempRoot`; `promoteTemporaryToLongTerm`; `disposeTemporaryHome` |

## Module layout

```
apps/service/src/agentHome/
  agentHomeTypes.ts
  homeTemplates.ts
  firstmateHardRules.ts
  agentHomeService.ts
  agentHomeService.test.ts
  index.ts
```

## API sketch (for later wiring)

```ts
const homes = await AgentHomeService.open({
  longTermRoot: ".../agent-homes",
  tempRoot: ".../agent-homes-temp"
});
await homes.ensureLongTermHome(roleId, { displayName });
const temp = await homes.createTemporaryHome({ displayName });
await homes.promoteTemporaryToLongTerm({ tempHomeId: temp.homeId, roleId });
const ctx = await homes.loadContext(roleId, {
  layers: ["project_facts"],
  projectId,
  includePrivateMemory: false
});
const system = homes.composeInstructions(ctx); // hard rules first
```

## Explicit non-goals (this task)

- No `app.ts` / HTTP routes (ownership boundary)
- No full test suite / no push
- No NextClaw brand/channel copy — templates adapted for PAW isolation

## Verification

```bash
npx vitest run apps/service/src/agentHome
# 16 passed
```
