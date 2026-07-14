# Task 44 — Doctor, logs, runtime health

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/doctor/**` only  
**Tests:** `npx vitest run apps/service/src/doctor` → **13 passed / 2 files**

## What was built

Machine-readable Status + Doctor diagnostics inspired by NextClaw `status --json` / `doctor --json` and `waitForHealth`:

| Capability | Implementation |
|---|---|
| Status report | `RuntimeStatusReport` with level, process, endpoints, health, summary, issues, recommendations |
| Doctor checks | Service, health, tray, PWA, port, data dir, state files, Credential Manager, disk, providers, models, Codex, runtime adapters, MCP, Git, worktree, Office/WPS, logs |
| Check outcomes | `pass` / `warn` / `fail` / `skip` + stable `code` + optional `remediation` / `fixable` |
| Closed-loop | `POST /api/doctor/run` re-runs checks; after fix, verify `exitCode===0` + `level==='healthy'` |
| Safe fix | Only with explicit `confirm: true`; creates data/log dirs (custom handlers injectable) |
| Logs | Service / crash / rotated archives; redacted by default; line + byte caps |
| Diagnostic pack | `diagnostics/pack-*/` with status.json, doctor.json, redacted logs, manifest (`secretsExcluded: true`) |
| Firstmate contract | `GET /api/doctor/contract` — read schema before invoking |
| waitForHealth | Exported poll helper (NextClaw-style) for runtime process diagnostics |

## Files

```
apps/service/src/doctor/
  doctorTypes.ts          # types, check ids, DOCTOR_OPERATION_CONTRACT
  doctorService.ts        # DoctorService + waitForHealth + redactLogText
  doctorService.test.ts
  doctorRoutes.ts         # HTTP routes + createDoctorRouteApp
  doctorRoutes.test.ts
  index.ts
```

## Routes (`doctorRoutes.ts`)

- `GET  /api/doctor/contract`
- `GET  /api/doctor/status`
- `GET  /api/doctor`
- `POST /api/doctor/run` — re-check; `{ fix: true }` requires `confirm: true`
- `POST /api/doctor/fix` — body must include `confirm: true`
- `GET  /api/doctor/logs`
- `GET  /api/doctor/logs/crash`
- `GET  /api/doctor/logs/archives`
- `GET  /api/doctor/logs/archives/:name`
- `POST /api/doctor/export`

## Mount notes (wiring agent — out of ownership)

```ts
import { DoctorService, createDoctorRouter } from "../doctor/index.js";

const doctor = new DoctorService({
  version: serviceVersion,
  dataDirectory,
  port,
  servicePid: process.pid,
  webRoot: process.env.PAW_WEB_ROOT,
  connections,
  codex: codexCli,
  mcp,
  git: { run: (args, cwd) => gitRuntime.run(args, cwd ?? dataDirectory) },
  worktrees: { countActive: async () => /* active sessions */, statePath: join(dataDirectory, "worktrees.json") },
  runtimes: runtimeRegistry,
  disk: resourceGuard /* or NodeDiskStatsProvider */,
  tray: async () => ({ present: /* tray probe */, detail: "..." }),
  credentialVaultProbe: async () => ({ available: true, detail: "Windows Credential Manager" }),
  office: async () => ({ office: false, wps: false, detail: "not probed" }),
  healthProbe: (url) => defaultHealthProbe(url) // or inject when testing
});
app.use(createDoctorRouter({ doctor }));
// optional health capability: "doctor"
```

## Safety

- Secrets never returned in status/doctor/logs/export (`redactLogText` + shared `redactSecrets`).
- Auto-fix rejected without `confirm === true` (HTTP 400).
- Archive path traversal blocked (plain file name only).
- Log reads capped (`MAX_LOG_LINES=500`, default max bytes 256KiB).
- Recommendations are machine-attached to checks; Firstmate must use `code` / `status` / contract, not UI copy.

## Tests summary

- Helper: summarize / exitCode / health level / waitForHealth
- Healthy path + degraded (disk/providers/codex)
- Fix requires confirm; log-dir + data-dir safe fixes + recheck
- Redacted service/crash logs + archive listing
- Diagnostic pack secrets excluded
- Orphan port detection
- HTTP routes via supertest standalone app

## Not done here (by design)

- No edits to `http/app.ts` or `main.ts`
- No full suite / no push
- No UI
- Tray/Office/Credential probes are injectable ports (defaults skip when unwired)
