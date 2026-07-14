# TEMP — Task 34 Coursework composite workflow

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/coursework/**` only  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/coursework` → **31 passed / 7 files**

## What shipped

Coursework delivery pack composing research + documents + subtasks + verification + review gates: assignment-brief spec extract, Secondmate DAG plan (research → develop → test → materials → docs), scoring-point map to impl/run/report, fake-UI consistency gates, runnable ZIP package, `/no-mistakes` multi-gate review, **user accept required** before `completed`.

| File | Role |
| --- | --- |
| `courseworkTypes.ts` | Session, spec, scoring map, scope, evidence, delivery, review types |
| `specExtract.ts` | Heuristic (+ optional model) extract: requirements, 评分点, prohibitions, delivery, missing info |
| `scoringMap.ts` | Scoring point → implementation_file / run_evidence / report_chapter / screenshot / test_record |
| `planCoursework.ts` | Secondmate plan as `ExplicitSubtaskDef[]`; minimal_modify scope for existing projects |
| `consistencyGates.ts` | Fake/shell UI detection; report vs evidence; scope violations; structured test authenticity |
| `deliveryPackage.ts` | README / RUN / DEPENDENCIES / SCORING_MAP / evidence catalog + ZIP (`buildZipStore`) |
| `noMistakesReview.ts` | Scoring coverage + feature regression + data authenticity + delivery completeness |
| `courseworkService.ts` | Orchestration + durable `coursework.json`; optional research/documents/subtasks clients |
| `index.ts` | Public exports |
| `*.test.ts` | Scoped TDD (31 tests) |

## Checklist coverage

- [x] Extract functional requirements, scoring points, prohibitions, delivery format, missing critical info
- [x] Secondmate-style dependent research / development / testing / materials / documentation subtasks
- [x] Code, tests, screenshots, report consistency — placeholder/fake UI never covers scoring
- [x] Each scoring point maps to implementation files, run evidence, and/or report chapters
- [x] Minimal modification principle: retained features + allowed modification scope
- [x] Final package: runnable notes, deps/run docs, test records, screenshots, report, ZIP
- [x] `/no-mistakes` on scoring coverage, feature regression, data authenticity, delivery completeness
- [x] Only `completed` after user final accept (and passed review)

## Flow (service API)

```ts
const cw = await CourseworkService.open({
  statePath: join(dataDirectory, "coursework.json"),
  model: fakeOrRealModelProvider,
  packageDir: join(workspace, "artifacts", "coursework"),
  subtasks: subtaskDagService,   // optional Task 21 client
  research: researchService,     // optional Task 32 client
  documents: documentService,    // optional Task 33 client
});

const session = await cw.createSession({
  title, goal, assignmentBrief, existingProjectNotes, runId, projectId
});
await cw.extractSpec(session.id);
// optional: resolveMissing(session.id, missId, answer)
await cw.generatePlan(session.id);          // awaiting_plan_approval
await cw.approvePlan(session.id);           // materializes DAG when subtasks+runId set

await cw.linkResearchSession(session.id);   // or pass existing id
await cw.linkDocumentSession(session.id);
await cw.importResearchEvidence(session.id, evidenceList);

await cw.addEvidence(session.id, {
  kind: "implementation", title, path, relatedScoringPointIds
});
await cw.addEvidence(session.id, {
  kind: "verification", title, relatedScoringPointIds, verification // Task 25 shape
});
// isPlaceholder: true → never covers scoring; fails authenticity review

await cw.runConsistencyCheck(session.id, { changedPaths, reportClaims });
const { zipBytes, manifest } = await cw.buildPackage(session.id);
const { review } = await cw.runNoMistakesReview(session.id);
// status → awaiting_user_accept only when review.conclusion === "passed"
await cw.acceptDelivery(session.id);        // required for status completed
```

## Client imports (no ownership bleed)

- **subtasks:** `ExplicitSubtaskDef`, `CreateDagFromPlanInput`, `TaskType`; optional `createFromApprovedPlan`
- **research:** `ResearchEvidence`; optional `createSession`; local evidence import
- **documents:** `buildZipStore` / `contentHash` for ZIP; optional `createSession`
- **verification:** `VerificationEvidence` + `buildVerificationEvidence` in tests/gates
- **model:** injectable `ModelProvider` / `FakeModelProvider`

## Intentionally not done (ownership boundary)

- **Did not edit** `apps/service/src/http/app.ts`, `main.ts`, research/documents/subtasks/verification/review modules, or PWA.
- No full agent execution loop inside coursework (plan + evidence + gates only).
- No real LLM required (heuristics + FakeModelProvider).
- No push; no full suite.

## Mount notes (wiring agent)

```ts
import { CourseworkService } from "../coursework/index.js";
const coursework = await CourseworkService.open({
  statePath: join(dataDirectory, "coursework.json"),
  model: /* ModelProvider */,
  packageDir: join(projectWorkspace, "artifacts", "coursework"),
  subtasks: subtaskDagService,
  research: researchService,
  documents: documentService,
});
```

## Tests summary

- Spec extract: requirements/scores/prohibitions/delivery/missing; model merge; resolve missing
- Scoring map: strong vs weak coverage; placeholder rejection
- Plan: DAG chain; minimal_modify retained/allowed; model merge + `toCreateDagFields`
- Consistency: fake UI, scope, structured tests vs keyword-only pass, report mismatch
- Delivery: ZIP magic, disk write, completeness gaps
- No-mistakes: pass/fail gates; archive only after user accept
- Service E2E: extract → plan approve (+ DAG client) → evidence → package → review fail on placeholder → clean path → accept → persist
