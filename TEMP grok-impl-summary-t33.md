# TEMP — Task 33 Document/paper workflow

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/documents/**` only  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/documents` → **36 passed / 8 files**

## What shipped

Document/paper writing pack: import Markdown/DOCX/PDF templates and user materials (original vs generated), Secondmate outline via FakeModel + user approval, grounded chapter writing (project facts + materials + ResearchEvidence only), citation traceability with APA/IEEE/GB7714 bibliography, terminology/data consistency + version diff, pure MD/DOCX/PDF export (local files as source of truth), and Office/WPS external-edit detection → re-review.

| File | Role |
| --- | --- |
| `documentTypes.ts` | Session, materials, outline, chapters, citations, exports, watches |
| `materialImport.ts` | MD / DOCX (ZIP store) / PDF import; Evidence → material; original vs generated |
| `outline.ts` | Secondmate outline via `ModelProvider`; approve/reject gates |
| `writing.ts` | Chapter write/revise; fabrication heuristics; citation keys |
| `citations.ts` | Build/check citations; APA / IEEE / GB7714 bibliography |
| `consistency.ts` | Terminology + data-point consistency; version line diff |
| `exportFormats.ts` | Pure Markdown, minimal OOXML DOCX ZIP, simple PDF |
| `externalEdit.ts` | Hash/mtime watch after export; change → needs re-review |
| `documentService.ts` | Orchestration + durable `documents.json` state |
| `index.ts` | Public exports |
| `*.test.ts` | Scoped TDD (36 tests) |

## Checklist coverage

- [x] Import Markdown, Word (DOCX), PDF templates/materials; original vs generated markers
- [x] Secondmate outline: sections, material/Evidence bindings, acceptance criteria, missing data; user approve before write
- [x] Writer limited to project facts, user materials, Evidence — blocks unknown citations / invented stats/awards
- [x] Per-chapter generate, revise, version compare, terminology/data consistency
- [x] Citations trace to Evidence/material; APA (default) + IEEE + GB7714
- [x] Export local Markdown, DOCX, PDF; disk files are formal artifacts
- [x] External edit detection after Office/WPS save → `needs_rereview`

## Flow (service API)

```ts
const docs = await DocumentService.open({
  statePath: join(dataDirectory, "documents.json"),
  model: fakeOrRealModelProvider,
  exportDir: join(workspace, "exports"),
});

const session = await docs.createSession({
  title, goal, projectFacts: ["…"], bibliographyStyle: "apa"
});
await docs.importMarkdown(session.id, { text, kind: "template" });
await docs.importDocxBytes(session.id, docxBytes, { kind: "user_material" });
await docs.importPdfBytes(session.id, pdfBytes, { pageTexts });
await docs.importEvidence(session.id, researchEvidenceList); // Task 32 types

await docs.generateOutline(session.id);   // awaiting_outline_approval
await docs.approveOutline(session.id);    // required before writing

await docs.writeChapter(session.id, sectionId);
await docs.writeChapter(session.id, sectionId, { revisionNote: "…" });
docs.compareVersions(session.id, chapterId, 1, 2);
await docs.runConsistencyCheck(session.id);
await docs.checkCitations(session.id);

const { markdown, docx, pdf, artifacts } = await docs.exportAll(session.id);
// edit file in Word/WPS…
const { rereviewRequired } = await docs.detectExternalEdits(session.id);
```

## Intentionally not done (ownership boundary)

- **Did not edit** `apps/service/src/http/app.ts`, `main.ts`, research module, or PWA.
- No full online Office editor; no real LLM (FakeModelProvider / injectable `ModelProvider`).
- DOCX import supports ZIP store (method 0) packages produced by our exporter; deflate-only third-party DOCX is best-effort.
- No push; no full suite.

## Mount notes (wiring agent)

```ts
import { DocumentService } from "../documents/index.js";
const documents = await DocumentService.open({
  statePath: join(dataDirectory, "documents.json"),
  model: /* ModelProvider from model runtime */,
  exportDir: join(projectWorkspace, "artifacts", "documents"),
});
// optional HTTP routes later; ResearchService.importEvidence can feed docs.importEvidence
```

## Tests summary

- Material import: MD / DOCX ZIP / PDF metadata+pages / Evidence binding / origin flags
- Outline: FakeModel JSON, id binding validation, approve/reject
- Writing: grounded success, pre-approval block, fabrication block, multi-version revise
- Citations: APA/IEEE/GB7714, body key extract, traceability fail on ghosts
- Consistency: term/data conflicts, version diff
- Export: MD + DOCX round-trip + PDF header
- External edit: hash change + missing file
- Service E2E + persistence + re-review status
