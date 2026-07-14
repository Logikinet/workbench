# Task 45 — Runtime watchdog + update rollback

**Status:** implemented (module only; not wired into `app.ts` / `main.ts` / tray)  
**Ownership:** `apps/service/src/watchdog/**` only  
**Tests:** `npx vitest run apps/service/src/watchdog` → **37 passed / 7 files**  
**No full suite. No push.**

## What was built

NextClaw-inspired Launcher/Runtime recovery + Candidate → Last Known Good updates (PWA + Tray shape preserved):

| Capability | Implementation |
|---|---|
| Health gate | `RuntimeWatchdog.start` always `waitForHealth` before `running`; exposes actual `port` / `baseUrl` / `healthUrl` |
| Limited exponential restart | `computeRuntimeRestartDelayMs` = NextClaw `min(15000, 500 * 2^(n-1))` + `maxAttempts` (default 10) |
| One-click stop recovery | `stopRecovery()` / `POST /api/watchdog/recovery/stop` cancels timers; `resetRecovery` clears exhausted |
| Control plane decoupling | Watchdog is pure controller over injectable `RuntimeProcessController` — Tray stays up when service dies |
| Bundle / update manifests | Version, platform/arch, min launcher, `migrationVersion`, entrypoints; signed remote update manifest |
| Integrity | SHA-256 + Ed25519 (Node crypto) or HMAC-SHA256 fallback |
| Candidate → LKG | `activateVersion` → candidate; `markVersionHealthy` after health; `failCandidate` / `recoverPendingCandidate` rollback |
| Bad versions | Failed candidates added to `badVersions`; refuse re-activate / download |
| Data migration | Backup workbench files only (`projectFilesExcluded: true`); restore on apply failure; blocks workspace paths |
| UI update snapshot | check / download / apply with `requiresRestart`, `canApply`, progress, block reasons |

## Files

```
apps/service/src/watchdog/
  watchdogTypes.ts          # types, DEFAULT_RESTART_POLICY, WATCHDOG_OPERATION_CONTRACT
  restartPolicy.ts          # computeRuntimeRestartDelayMs + caps
  restartPolicy.test.ts
  integrity.ts              # sha256, ed25519, hmac, canonical unsigned manifest
  manifests.ts              # parse bundle/update manifests + verify
  manifests.test.ts
  launcherState.ts          # persistent LKG / candidate JSON store
  bundleLifecycle.ts        # activate / markHealthy / rollback
  bundleLifecycle.test.ts
  dataMigration.ts          # backup → migrate → rollback
  dataMigration.test.ts
  runtimeWatchdog.ts        # process recovery loop
  runtimeWatchdog.test.ts
  updateCoordinator.ts      # check / download / apply
  updateCoordinator.test.ts
  watchdogService.ts        # facade for routes
  watchdogRoutes.ts         # HTTP + createWatchdogRouteApp
  watchdogRoutes.test.ts
  index.ts
```

## Routes (`watchdogRoutes.ts`)

- `GET  /api/watchdog/contract`
- `GET  /api/watchdog/runtime` — process + recovery + **actual port** (PWA must not guess)
- `POST /api/watchdog/recovery/stop`
- `POST /api/watchdog/recovery/reset`
- `GET  /api/watchdog/update`
- `POST /api/watchdog/update/check`
- `POST /api/watchdog/update/download`
- `POST /api/watchdog/update/apply` — activates candidate; `requiresRestart: true`
- `POST /api/watchdog/bundle/mark-healthy` — body `{ version }` after health gate
- `POST /api/watchdog/bundle/recover-candidate`
- `POST /api/watchdog/bundle/fail-candidate`

## Mount notes (wiring agent — out of ownership)

```ts
import {
  RuntimeWatchdog,
  LauncherStateStore,
  BundleLifecycleService,
  UpdateCoordinator,
  WatchdogService,
  createWatchdogRouter
} from "../watchdog/index.js";

const runtime = new RuntimeWatchdog({
  controller: trayOrProcessController, // start/stop/probeHealth
  bindHost: "127.0.0.1",
  port,
  policy: { maxAttempts: 10 }
});

const stateStore = new LauncherStateStore(join(dataDirectory, "launcher-state.json"));
const lifecycle = new BundleLifecycleService(stateStore, bundleLayout);
const updates = new UpdateCoordinator({
  launcherVersion,
  stateStore,
  lifecycle,
  installStore,
  verify: { publicKeyPem: process.env.PAW_UPDATE_PUBLIC_KEY },
  manifestUrl: process.env.PAW_UPDATE_MANIFEST_URL
});

const watchdog = new WatchdogService({ runtime, updates, lifecycle });
app.use(createWatchdogRouter({ watchdog }));
// After candidate boot + health ok:
//   await watchdog.markHealthy(version)
// After candidate health fail:
//   await watchdog.failCandidate(version)
```

Tray/ProcessManager can adopt `RuntimeWatchdog` later for crash recovery without changing PWA→Electron.

## Safety

- Recovery is limited (`maxAttempts`); user can stop the loop anytime.
- Updates never become LKG without explicit `markVersionHealthy` post-health.
- Bad versions are sticky until a later healthy promote removes them.
- Migration backups set `projectFilesExcluded: true`; path guard blocks `workspaces/` / traversal.
- Signature verification required on manifest + bundle payload before install.

## Tests summary

- Restart delay matches NextClaw (500…15000) + attempt cap
- Health gate start; fail stops child; unexpected exit schedules backoff; stop recovery; exhaust; expected exit no restart
- Candidate activate / LKG / first-launch recover / fail + bad list
- Migration backup + rollback; workspace path rejection
- Signed check/download/apply; tamper reject; bad version block; up-to-date; failCandidate
- HTTP contract, runtime port, recovery stop/reset, mark-healthy validation

## Not done here (by design)

- No edits to `http/app.ts`, `main.ts`, or `apps/tray/**`
- No full suite / no push
- No real remote CDN / installer packaging of multi-version dirs
- No PWA update UI (snapshot API ready for UI agent)
