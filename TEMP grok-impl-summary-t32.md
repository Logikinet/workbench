# TEMP — Task 32 Evidence-first research workflow

**Status:** implemented (module only; not wired into `app.ts` / `main.ts`)  
**Ownership:** `apps/service/src/research/**` only  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/research` → **40 passed / 7 files**

## What shipped

Evidence-first research pack: web search/fetch (injectable fakes), PDF metadata import, traceable Evidence, claim binding with origin markers, parallel gather + pre-summary aggregation (dedup + conflicts), `research.md` / sources / evidence catalog artifacts, and Reviewer evidence hard gates.

| File | Role |
| --- | --- |
| `researchTypes.ts` | Session, Evidence, Claim, Source, Conflict, Reviewer check types |
| `webTools.ts` | `WebSearchPort` / `WebFetchPort` + `FakeWebSearch` / `FakeWebFetch` |
| `pdfImport.ts` | PDF Info metadata parse, page extractor port, `buildMinimalPdf` test helper |
| `evidence.ts` | Create/bind Evidence & Claims; quality flags; support heuristic |
| `researchWorkflow.ts` | Question split, parallel steps, dedup (richest canonical), conflicts, aggregate |
| `researchArtifacts.ts` | `research.md`, `sources.json`, `evidence/catalog.md` |
| `reviewerEvidenceHooks.ts` | Citation support checks; insufficient evidence must not pass |
| `researchService.ts` | Orchestration + durable `research.json` state |
| `index.ts` | Public exports |
| `*.test.ts` | Scoped TDD (40 tests) |

## Checklist coverage

- [x] Web search, page fetch, PDF import + metadata (title/author/dates/pages)
- [x] Evidence: title, author, source, publishedAt, accessedAt, excerpt, location
- [x] Facts/conclusions bind Evidence; AI inference vs user material distinct markers
- [x] Duplicate / invalid / low_trust / unreachable flagged — not auto final facts
- [x] Parallel gather steps; aggregate requires dedup + conflict organization first
- [x] Outputs `research.md`, structured sources, evidence catalog as Artifacts
- [x] Reviewer hooks: citation must support claim; insufficient → fail
- [x] Creative tasks: `forceEvidenceMode: false` skips hard binding

## Flow (service API)

```ts
const research = await ResearchService.open({
  statePath: join(dataDirectory, "research.json"),
  search: fakeOrRealSearch,
  fetch: fakeOrRealFetch,
  pdfExtractor,
  artifactWriter: { writeFile }
});

const session = await research.createSession({ title, goal, forceEvidenceMode: true });
await research.beginGathering(session.id);
await research.searchWeb(session.id, query);
await research.fetchPage(session.id, url);
await research.importPdfFile(session.id, pdfPath);
await research.addClaim(session.id, { text, kind: "fact", evidenceIds });
await research.aggregate(session.id);          // required before artifacts
await research.produceArtifacts(session.id);   // research.md + sources + catalog
const review = await research.checkEvidence(session.id);
await research.finalizeIfEvidenceOk(session.id);
```

## Reviewer integration hooks

```ts
import { checkResearchEvidence, toReviewerFindingRows, researchReviewMayPass } from "../research/index.js";

const result = checkResearchEvidence(session);
const rows = toReviewerFindingRows(result); // merge into Independent Reviewer findings
if (!researchReviewMayPass(result)) { /* changes_requested — do not pass */ }
```

## Intentionally not done (ownership boundary)

- **Did not edit** `apps/service/src/http/app.ts`, `main.ts`, `review/reviewService.ts`, or PWA.
- No real network search/fetch (ports only + fakes); no full PDF text engine (metadata + injectable page extractor).
- No push; no full suite.

## Mount notes (wiring agent)

```ts
import { ResearchService } from "../research/index.js";
const research = await ResearchService.open({
  statePath: join(dataDirectory, "research.json"),
  search: /* MCP or http search adapter */,
  fetch: /* page fetch adapter */,
});
// optional: research routes later; Reviewer can call checkResearchEvidence on run artifacts
```

## Tests summary

- Web tool fakes (no network)
- PDF metadata + page extract
- Evidence binding / quality / support
- Workflow: parallel steps, dedup keeps richest URL copy, conflicts
- Artifacts: research.md + sources.json + evidence/catalog.md
- Reviewer: pass/fail gates + creative mode off
- Service end-to-end + persistence
