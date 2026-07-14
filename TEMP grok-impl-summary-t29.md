# Task 29 — Review remediation loop

**Status:** implemented (scoped tests green)  
**Ownership:** `apps/service/src/review/**` + `apps/service/src/subtasks/**` (fix subtasks only)  
**Date:** 2026-07-15  
**No push.**

## What was built

End-to-end quality gate after independent review fails:

1. **Findings → constrained fix subtasks** (evidence, severity, allowedScope, acceptanceCriteria)
2. **Firstmate dispatch** picks original Professional Agent or a fix specialist — **never the Reviewer**
3. **Max 1 automatic remediation cycle**; still failing re-review → **pause for user**
4. **Independent re-review** (new review instance / cycle) after fix
5. **Gate:** no Todo complete / Worktree apply without **passed independent review + user accept**

### Module layout

| File | Role |
| --- | --- |
| `review/reviewRemediation.ts` | Pure helpers: build fix subtasks, constrained instruction, agent select, apply gate, pause policy |
| `review/reviewRemediation.test.ts` | Pure + integration TDD for the loop |
| `review/reviewService.ts` | Wires remediation into `performReview` / `dispatchFix`; exports gates |
| `subtasks/subtaskTypes.ts` | `origin`, `sourceReviewId`, `findingSeverity`, `AppendRemediationSubtasksInput` |
| `subtasks/subtaskDagService.ts` | `appendRemediationSubtasks` — create/append remediation DAG nodes, cancel prior incomplete fixes |

### Checklist

- [x] Each unmet review finding → fix subtask with evidence, severity, allowed scope, acceptance
- [x] Firstmate selects original or fix specialist; Reviewer never mutates / is not assigned
- [x] Fix instruction forbids unrelated refactor (“禁止顺手重构…”)
- [x] Fix cycle includes re-verification subtask; independent re-review uses fresh context
- [x] Default **maxAutoFixCycles = 1**; second auto attempt blocked; user-authorized fix still allowed
- [x] After exhausted auto cycle + still `changes_requested` → Run **paused** for user decision
- [x] Remediation subtasks + fix instruction + reviews land on Run timeline / subtasks.json
- [x] `canApplyWorktreeAfterReview` / `ReviewService.canApplyWorktree` require pass + user accept
- [x] Existing Todo formal-acceptance path still blocks complete without accept

### Flow

```
awaiting_review
  → performReview (independent)
      ├─ passed → awaiting_acceptance → user accept → completed
      └─ changes_requested
            ├─ autoFixCyclesUsed < 1 → build fix subtasks → appendRemediationSubtasks
            │     → prepareReviewFix + dispatchFixAgent → re-exec → awaiting_review (re-review)
            └─ auto budget exhausted → paused (user decides: authorize fix / re-scope)
```

### Wiring notes (integrator)

`ReviewService` optional deps:

```ts
new ReviewService({
  runs,
  todos,
  modelRuntime,
  reviewerRoleId,
  subtasks, // SubtaskDagService — enables DAG fix nodes
  fixSpecialists, // optional specialized agents
  dispatchFixAgent: (runId, instruction) => professionalAgents.start(runId, {})
});
```

Worktree apply HTTP routes can call:

```ts
import { canApplyWorktreeAfterReview } from "../review/reviewService.js";
// block apply unless gate.ok
```

### Tests

```text
npx vitest run apps/service/src/review apps/service/src/subtasks
# 5 files, 52 tests passed (~2.2s)
# log: test-logs/task-29-review-remediation.txt
```

No full monorepo suite. No push.

### Out of scope / notes

- Did not edit `app.ts` / `main.ts` (subtasks already optional on ReviewService)
- Did not edit `git/**` worktree apply routes; gate is exported for wiring
- Tightened `detectProhibitionViolation` so remediation policy text (“禁止顺手重构”) is not a false prohibition hit
