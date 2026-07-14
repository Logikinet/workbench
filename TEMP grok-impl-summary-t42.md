# TEMP — Task 42 Artifact document browser

**Status:** implemented (service `artifacts/**` + PWA browser panel)  
**Date:** 2026-07-15  
**Tests:** `npx vitest run apps/service/src/artifacts` → **19 passed / 4 files**

## What shipped

### Service (`apps/service/src/artifacts/`)

| File | Role |
| --- | --- |
| `artifactTypes.ts` | Catalog, browse, preview, office, export/package types |
| `pathSafety.ts` | Project-grant path resolution; blocks absolute / `..` / null-byte / symlink escape |
| `previewKinds.ts` | Extension → preview kind + mime + binary sniff |
| `zipOoxml.ts` | Dependency-free ZIP + DOCX/XLSX/PPTX readonly text extract; stored-zip packager |
| `officeOpen.ts` | Office/WPS detect + external open + explorer reveal (injectable) |
| `artifactBrowserService.ts` | Browse, preview, catalog versions/evidence/diff, change detect, export/package |
| `artifactRoutes.ts` | HTTP router + `createArtifactRouteApp` for unit tests |
| `index.ts` | Public exports |

**Ticket checklist:**

- [x] Safe browse under Project workspace grant; no path traversal
- [x] Built-in preview: Markdown, text, code, image, PDF
- [x] DOCX / XLSX / PPTX readonly text/HTML extract (OOXML; does not rewrite source)
- [x] Open with Office/WPS/default (stub-injectable); fingerprint + change detect after save
- [x] Artifact catalog: versions, creator, Run, review status, Evidence / Diff / source links
- [x] Code artifacts can carry worktree Diff links; research-style Evidence/source links
- [x] Large files: ranged text preview + size thresholds; preview errors do not mutate files
- [x] Reveal in file manager, copy path, export (copy+manifest), package (zip)

**Local files remain the only truth** — preview never rewrites formats.

### HTTP routes

```
GET    /api/artifacts/office-status
GET    /api/artifacts
POST   /api/artifacts
GET    /api/artifacts/:artifactId
PATCH  /api/artifacts/:artifactId
GET    /api/artifacts/:artifactId/versions
POST   /api/artifacts/:artifactId/versions
GET    /api/artifacts/projects/:projectId/browse?path=
GET    /api/artifacts/projects/:projectId/stat?path=
GET    /api/artifacts/projects/:projectId/preview?path=&offset=&limit=
POST   /api/artifacts/projects/:projectId/open-external
POST   /api/artifacts/projects/:projectId/detect-changes
POST   /api/artifacts/projects/:projectId/reveal
POST   /api/artifacts/projects/:projectId/copy-path
POST   /api/artifacts/projects/:projectId/export
POST   /api/artifacts/projects/:projectId/package
POST   /api/artifacts/runs/:runId/import
```

### PWA

- `apps/web/src/lib/artifacts.ts` — API client
- `apps/web/src/components/ArtifactBrowserPanel.tsx` — tree + preview + catalog meta
- `apps/web/src/styles.css` — artifact browser styles

## Intentionally not done (ownership boundary)

- **Did not edit** `apps/service/src/http/app.ts` or `main.ts` (parallel-task ownership).  
  Mount later:

  ```ts
  import { ArtifactBrowserService, createArtifactRouter } from "../artifacts/index.js";
  const artifacts = await ArtifactBrowserService.open({
    catalogPath: join(dataDirectory, "artifacts.json"),
    projects,
    runs
  });
  app.use(createArtifactRouter({ artifacts }));
  // advertise capability e.g. "artifacts"
  ```

- **Did not edit** `App.tsx` — `ArtifactBrowserPanel` is ready to mount when service exposes artifacts.
- No full Word/PDF render engine (PDF base64 embed for small files; office = text extract).
- No push; no full suite.

## Follow-ups

1. Wire `ArtifactBrowserService` + router in `main.ts` / `app.ts` and advertise capability `"artifacts"`.
2. Mount `<ArtifactBrowserPanel projectId={…} runId={…} />` in workbench Project/Run views (Task 30 UI).
3. Optional: true PDF page raster / richer OOXML HTML; share office probe with Doctor.
