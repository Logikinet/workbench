# Task 38 — Deterministic routing + session isolation

**Status:** implemented (service `routing/` only; no `app.ts` / no push)  
**Ownership:** `apps/service/src/routing/**` (imports `agentHome` types + may use `sessions` read-only)  
**Tests:** `npx vitest run apps/service/src/routing` → **29 passed / 5 files**

## Ticket checklist

| Item | Implementation |
| --- | --- |
| Rules match task type / Project / capabilities / Harness / manual / permissions | `routingRules.ts` `RoutingRuleMatch` + `evaluateRoutingRules` |
| Ordered first valid hit + explainable fallback | `sortRules` + `RuleEvaluation[]` + `fallbackCode` / `fallbackReason` |
| Manual agent designation outranks rules; invalid → pause (no silent fallback) | `DeterministicRoutingService.routeManual` + `manualOverrideRejects` |
| Scopes: global / project Firstmate, Run, Subtask, Reviewer | `sessionScopes.ts` `SessionScopeKind` + `buildSessionKey` |
| Session tags / preferred model / temporary instructions (no Role pollution) | `SessionLocalConfig` + overlay in `wrapDecision` |
| No cross-leak (reviewer / projects / client profiles) | `canShareContext` / `assertNoCrossLeak` / `filterContextForScope` |
| Decision stores matched rule, candidates, rejects, final reason | `SelectionTrace` on `DeterministicRoutingDecision` |
| Tests: rule order, fallback, manual override, isolation | `routingRules.test.ts`, `deterministicRoutingService.test.ts`, `sessionScopes.test.ts` |

## Module layout

```
apps/service/src/routing/
  roleRouterService.ts(.test)     # Task 20 (unchanged behavior)
  routingRoutes.ts(.test)         # Task 20 + optional Task 38 endpoints
  routingRules.ts(.test)          # Ordered bindings-style rules (pure)
  sessionScopes.ts(.test)         # Scope keys + isolation policy (pure)
  deterministicRoutingService.ts(.test)  # Task 38 façade
  index.ts                        # Public exports
```

## Routing priority

1. **Manual** `explicitRoleId` — validate permissions/availability; on failure **pause** (never fall through to rules).
2. **Rules** — deterministic `order` then `id`; first match with eligible role wins; `onInvalid: pause|continue`.
3. **Fallback** — Task 20 auto-rank / temporary role, with `fallbackReason` audit.

## Session keys (examples)

- `scope:global_firstmate`
- `scope:project_firstmate:project:abc`
- `scope:run:run:r1:project:p1`
- `scope:subtask:run:r1:subtask:s1`
- `scope:reviewer:run:r1:client:c1`

## HTTP (optional `deterministicRouter` dep)

```
GET/POST/PUT/DELETE  /api/routing/rules
POST                 /api/routing/isolation/check
POST                 /api/routing/decisions   # prefers deterministic when configured
```

Mount later (do **not** edit `app.ts` here):

```ts
const roleRouter = new RoleRouterService({ roles, connections });
const deterministicRouter = new DeterministicRoutingService({ roles, roleRouter });
app.use(createRoutingRouter({ roleRouter, deterministicRouter }));
```

## Explicit non-goals

- No `app.ts` / `main.ts` wiring
- No `sessions/**` mutation (isolation lives in routing; sessions package already has tags/model)
- No full suite / no push
- No NextClaw channel bindings or brand copy

## Verification

```bash
npx vitest run apps/service/src/routing
# 29 passed
```
