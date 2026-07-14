# TEMP — Task 41 Session management + Tool Cards

**Status:** implemented (service + PWA components)  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/sessions` → **23 passed / 3 files**

## What shipped

### Service (`apps/service/src/sessions/`)

| File | Role |
| --- | --- |
| `sessionTypes.ts` | Durable session / card / tool-card / ingest-event types |
| `toolCards.ts` | Pure ACP-inspired Tool Card helpers (permission infer, redact, duration, compact) |
| `sessionService.ts` | Durable `sessions.json`: CRUD, search/filter, message queue, event→cards, restore |
| `sessionRoutes.ts` | HTTP router + `createSessionRouteApp` for unit tests |
| `index.ts` | Public exports |

**Capabilities (ticket checklist):**

- [x] Search, tags, Project / Agent / status filters; clear + delete
- [x] Ordered turn cards: text, tool_call, ask_user / ask_approval / ask_replan, acceptance, artifact, system
- [x] Tool Card: tool name, args summary, permission, status, duration, output summary, artifact/evidence links
- [x] Input stays usable while `streaming` → queue / correction / force
- [x] AskUser / AskApproval / AskReplan / acceptance answerable on timeline
- [x] Session-only `preferredModelId` + tags (does not mutate global Role)
- [x] Paginated/compact cards + collapse (virtualization-friendly for PWA)
- [x] Persist + reopen restores card order, pending interactions, status

**Event shapes:** Inspired by ACP `session/update` (`tool_call` / `tool_call_update`, ToolCallStatus) and local `RuntimeEvent` kinds — not a wire copy of NextClaw.

### HTTP routes

```
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:sessionId
PATCH  /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
POST   /api/sessions/:sessionId/clear
GET    /api/sessions/:sessionId/cards?afterSequence&beforeSequence&limit&compact
POST   /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/events
POST   /api/sessions/:sessionId/queue/drain
POST   /api/sessions/:sessionId/cards/:cardId/collapse
POST   /api/sessions/:sessionId/turns/:turnId/collapse
POST   /api/sessions/:sessionId/cards/:cardId/answer
```

### PWA

- `apps/web/src/lib/sessions.ts` — API client
- `apps/web/src/components/SessionPanel.tsx` — list/search/filters/composer
- `apps/web/src/components/ToolCards.tsx` — ordered cards + Tool Card UI
- `apps/web/src/styles.css` — session/tool-card styles

## Intentionally not done (ownership boundary)

- **Did not edit** `apps/service/src/http/app.ts` or `main.ts` (parallel-task ownership).  
  Mount later:

  ```ts
  import { SessionService, createSessionRouter } from "../sessions/index.js";
  const sessions = await SessionService.open(join(dataDirectory, "sessions.json"));
  // createApp({ ..., sessions })
  app.use(createSessionRouter({ sessions }));
  ```

- **Did not edit** `App.tsx` — `SessionPanel` is ready to mount when service exposes sessions capability.
- No push; no full suite.

## Follow-ups

1. Wire `SessionService` + router in `main.ts` / `app.ts` and advertise capability e.g. `"sessions"`.
2. Mount `<SessionPanel />` in App or embed in Run timeline (Task 30 UI polish).
3. Host orchestration: map RuntimeEvent / toolLoop events → `POST .../events`; drain queue on `stream_end`.
