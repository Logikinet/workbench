# Task 31 — Windows E2E release gate (automated harness)

**Status:** implemented (CI-safe automated checklist; full desktop E2E residual risks documented)  
**Ownership:** `apps/service/src/releaseGate/**`, `scripts/e2e/**`, `reports/`  
**Tests:** `npx vitest run apps/service/src/releaseGate` → **12 passed / 1 file**  
**Report:** `npm run release-gate` → `reports/release-gate-acceptance.md` (+ `.json`)  
**No full suite. No push.**

## What was built

Automated release-gate checklist runner that is **CI-safe** (never requires real OpenAI/Codex credentials):

| Check | Code | What it validates |
|---|---|---|
| Install scripts present | `INSTALL_SCRIPTS_OK` | `packaging/windows/*` (Install, Uninstall, Upgrade, paths, TrayHost) |
| Uninstall preserves data | `UNINSTALL_PRESERVES_DATA` | `planUninstall` default preserve data + refuse external workspaces; PS1 contracts (`DELETE-WORKBENCH-DATA`) |
| Credential vault redaction | `CREDENTIAL_VAULT_REDACTION_OK` | Secrets only in vault; public rows / index JSON / backup snapshot / `redactSecrets` never leak keys |
| Fake-provider plan+execute | `FAKE_PROVIDER_PLAN_EXECUTE_OK` | Firstmate/Secondmate plan + multi-turn tool-loop execute via `FakeModelProvider` |
| Acceptance report written | `ACCEPTANCE_REPORT_WRITTEN` | Markdown + JSON under `reports/` |

### Residual environment risks (not CI failures)

Documented in the acceptance report:

- **Real OpenAI-compatible API key** (Windows Credential Manager) — blocker for full live E2E
- **Real Codex CLI login session** — blocker for worktree/review/apply path
- Clean Windows user-profile install of Service + Tray + PWA
- Live Windows Credential Manager host vs in-memory vault in CI

## Files

```
apps/service/src/releaseGate/
  releaseGateTypes.ts         # check ids, summary, environment risks
  packagingGate.ts            # install scripts + planUninstall contracts
  credentialVaultGate.ts      # vault / public / backup / redact contracts
  fakeProviderGate.ts         # AI plan + tool-loop execute (FakeModelProvider)
  reportWriter.ts             # markdown + JSON under reports/
  releaseGateRunner.ts        # orchestrator
  releaseGateRunner.test.ts   # TDD suite (12 tests)
  index.ts

scripts/e2e/
  write-release-gate-report.mts   # npm run release-gate
  run-release-gate.mjs            # post-build dist CLI fallback

reports/
  release-gate-acceptance.md
  release-gate-acceptance.json
```

## Commands

```bash
# Unit tests only (recommended CI gate)
npm run test:release-gate
# or
npx vitest run apps/service/src/releaseGate

# Produce acceptance report under reports/
npm run release-gate
```

## Design notes

- Tray `planUninstall` is loaded via **dynamic import** (src or dist) so service `rootDir` is not polluted by cross-package static imports.
- Fake plan+execute reuses production `AiPlanningService` + `runToolLoop` with injectable `FakeModelProvider` — no network.
- Report always includes real Codex / real API key as **environment risks**, not failing checks.

## Not done here (by design)

- No full clean-profile Windows desktop install of Service/Tray/PWA
- No live OpenAI-compatible or Codex CLI sessions
- No wiring into `http/app.ts` / tray main (module + scripts only)
- No full monorepo test suite / no push
