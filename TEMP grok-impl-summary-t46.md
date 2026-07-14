# Task 46 — Plugin/Extension SDK

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/plugins/**` only  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/plugins` → **14 passed / 2 files**

## What was built

Local Plugin/Extension SDK inspired by NextClaw `extension-sdk` + `extension-runtime` (manifest file, stdio lifecycle, contribution registry, parent-PID watch) — **no** chat channels, marketplace brand, or cloud deps.

| Capability | Implementation |
|---|---|
| Manifest | `paw.plugin.json` — id, version, `apiVersion`, engine range, entry, permissions, configSchema, secretsSchema, contributes |
| Lifecycle | install / enable / disable / update / rollback / uninstall (`confirm: true` gates) |
| Permissions | Declared ∩ operator-approved only; contribution register requires matching `*.register` permission |
| Isolation | `stdio` child process (JSON-lines IPC) or `inprocess` (try/catch); crash → `status: crashed`, host continues |
| Contributions | Provider, Harness, Tool, Skill Source, Artifact Renderer, Trigger via `PluginContributionRegistry` |
| Config / secrets | Config sanitized + persisted; secrets in `CredentialVault` only; `exportBackupSlice()` sets `secretsExcluded: true` |
| Core upgrade | `applyCoreCompatibility(coreVersion)` auto-disables out-of-range / bad API plugins with user-visible `lastError` |
| Sample | `sample/hello-tool` — minimal tool contribution `hello.greet` |

## Files

```
apps/service/src/plugins/
  pluginTypes.ts           # Manifest, permissions, contributions, state, public DTOs
  pluginCompat.ts          # API major + engine semver range checks
  pluginPermissions.ts     # Approval validation + assertPermission
  pluginManifest.ts        # parse/load/hash paw.plugin.json
  pluginHost.ts            # Process isolation + stdio runtime helper
  pluginRegistry.ts        # Six contribution kinds
  pluginService.ts         # Lifecycle + backup slice + crash handling
  pluginService.test.ts
  pluginContract.test.ts   # Full ticket contract coverage
  sample/hello-tool/
    paw.plugin.json
    main.mjs
  index.ts
```

## Ticket checklist

- [x] Extension Manifest, API version, entry, capabilities, permissions, config schema, compatibility range
- [x] Local install, enable, disable, update, rollback, uninstall
- [x] Extensions only get declared + operator-approved permissions
- [x] Third-party extensions isolated; crash does not take down workbench
- [x] Provider / Harness / Tool / Skill Source / Artifact Renderer / Trigger registerable
- [x] Config separated from secrets; ordinary backup excludes secret values
- [x] Core upgrade compatibility check; incompatible auto-disabled with reason
- [x] Minimal sample extension + full contract tests

## Mount notes (wiring agent — out of ownership)

```ts
import {
  PluginService,
  MemoryPluginVault,
  createStdioPluginRuntime
} from "../plugins/index.js";

const plugins = await PluginService.open({
  statePath: join(dataDirectory, "plugins-state.json"),
  installRoot: join(dataDirectory, "installed-plugins"),
  coreVersion: serviceVersion, // e.g. package.json version
  vault // shared CredentialVault
});

// After core upgrade:
await plugins.applyCoreCompatibility(newCoreVersion);

// Shutdown:
await plugins.shutdown();
```

## Intentionally not done

- Did **not** edit `apps/service/src/http/app.ts` or `main.ts` (parallel ownership).
- Did **not** add HTTP routes (service + contract only; routes can follow wiring).
- No chat-channel extensions, Electron shell, or marketplace.
- No push; no full suite.

## Design notes

- Manifest filename: `paw.plugin.json` (NextClaw uses `nextclaw.extension.json`).
- Host API version: `PLUGIN_API_VERSION = "1"` (major must match).
- Engine range: `minCoreVersion` inclusive, `maxCoreVersion` exclusive.
- Install copies package under `{installRoot}/{id}/current`; history under `{installRoot}/{id}/history/...`.
- Incompatible installs are stored but cannot be enabled until core/API range fits.
