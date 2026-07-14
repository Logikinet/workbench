# Task 43 — Local Cron / Webhook / automation triggers

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/automation/**` only  
**Tests:** `npx vitest run apps/service/src/automation` → **16 passed / 3 files**

## What was built

Local automation inspired by NextClaw cron reliability (no cloud channels):

| Capability | Implementation |
|---|---|
| One-shot | `schedule.kind: "once"` + ISO `at`; optional `deleteAfterRun` (default true for once) |
| Periodic | `every` (`everyMs` ≥ 1000) and 5-field `cron` expr (no extra npm dep) |
| Manual | `schedule.kind: "manual"` + `POST .../run` (force for disabled) |
| Webhook | Token (Bearer / `X-PAW-Webhook-Token`), source allow-list (default loopback), structured event schema |
| Enable/disable/delete | Jobs + webhooks |
| Next run + history | `state.nextRunAt`, `GET .../history`, global audit timeline |
| Idempotency | Scheduled slot keys + webhook `idempotencyKey` / `eventId` |
| Missed offline | `missedRunPolicy: "skip"` (default) or `"catch_up_one"` — never batch-fires |
| Human gates | Actions only create todos/runs/messages/flow accept; **never** plan approve / danger approve / accept |

## Files

```
apps/service/src/automation/
  automationTypes.ts
  cronSchedule.ts
  cronSchedule.test.ts
  automationService.ts
  automationService.test.ts
  automationRoutes.ts
  automationRoutes.test.ts
  index.ts
```

## Routes (`automationRoutes.ts`)

- `GET/POST /api/automation/jobs`
- `GET/PATCH/DELETE /api/automation/jobs/:jobId`
- `POST /api/automation/jobs/:jobId/enable|disable|run`
- `GET /api/automation/jobs/:jobId/history`
- `GET /api/automation/history`
- `GET /api/automation/status`
- `GET/POST /api/automation/webhooks`
- `GET/DELETE /api/automation/webhooks/:webhookId`
- `POST /api/automation/webhooks/:webhookId/enable|disable|rotate-token`
- `POST /api/hooks/:webhookId` — inbound local webhook

## Mount notes (wiring agent — out of ownership)

```ts
import { AutomationService, createAutomationRouter } from "../automation/index.js";

const automation = await AutomationService.open({
  statePath: join(dataDirectory, "automation.json"),
  todos,
  runs,
  // flows?: optional preset-flow port
});
await automation.start();
app.use(createAutomationRouter({ automation, clientAddress }));
// on shutdown: automation.stop()
```

Do **not** inject approval/accept methods into the ports — only `todos.create`, `runs.create`, `runs.addUserMessage`, `flows.trigger`.

## Safety

- Every `ActionExecutionResult` / audit `result` sets `requiresHumanGates: true`.
- New Runs land via normal create path (tests use `awaiting_plan_approval`).
- Webhook tokens stored as SHA-256; plaintext only on create/rotate.
- Unknown webhook event types rejected; source restriction defaults to loopback.
- Fully local — no public internet control surface beyond existing loopback service binding.

## Tests summary

- Schedule validation + cron next-fire
- Job CRUD / enable / manual run without calling decidePlan / danger / accept
- `skip` vs `catch_up_one` missed policy
- Webhook token / source / schema / idempotency
- Durable JSON state
- HTTP routes via supertest standalone app

## Not done here (by design)

- No edits to `http/app.ts` or `main.ts` (same pattern as skills/tools routes)
- No full suite / no push
- No UI
