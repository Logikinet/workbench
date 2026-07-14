import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactBrowserService } from "./artifactBrowserService.js";
import { createArtifactRouteApp } from "./artifactRoutes.js";

describe("artifact routes (Task 42)", () => {
  let workspace: string;
  let exportDir: string;
  let app: ReturnType<typeof createArtifactRouteApp>;
  let artifacts: ArtifactBrowserService;
  const projectId = "proj-route";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "paw-art-rt-"));
    exportDir = await mkdtemp(join(tmpdir(), "paw-art-rx-"));
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "hello.md"), "# Hello\n", "utf8");
    await writeFile(join(workspace, "docs", "a.txt"), "alpha", "utf8");

    artifacts = await ArtifactBrowserService.createMemory({
      projects: {
        async get(id) {
          if (id !== projectId) throw new Error(`Project ${id} was not found.`);
          return { id: projectId, name: "Route Project", workspacePath: workspace };
        }
      },
      runs: {
        async get(runId) {
          return {
            id: runId,
            todoId: "t1",
            artifacts: [
              {
                id: "ra1",
                path: "hello.md",
                kind: "document",
                createdAt: "2026-07-15T00:00:00.000Z"
              }
            ],
            reviews: [{ id: "rv1", status: "passed", summary: "lgtm" }]
          };
        }
      },
      openExternal: async ({ absolutePath, relativePath }) => ({
        ok: true,
        absolutePath,
        relativePath,
        app: "default",
        message: "opened",
        stub: true
      }),
      reveal: async ({ absolutePath, relativePath }) => ({
        ok: true,
        absolutePath,
        relativePath,
        message: "revealed",
        stub: true
      }),
      detectOffice: async () => ({ office: true, wps: true, detail: "both" })
    });
    app = createArtifactRouteApp({ artifacts });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  });

  it("browses, stats, previews, and rejects traversal via API", async () => {
    const browse = await request(app)
      .get(`/api/artifacts/projects/${projectId}/browse`)
      .expect(200);
    expect(browse.body.entries.some((e: { name: string }) => e.name === "hello.md")).toBe(true);

    const nested = await request(app)
      .get(`/api/artifacts/projects/${projectId}/browse`)
      .query({ path: "docs" })
      .expect(200);
    expect(nested.body.entries.some((e: { name: string }) => e.name === "a.txt")).toBe(true);

    const st = await request(app)
      .get(`/api/artifacts/projects/${projectId}/stat`)
      .query({ path: "hello.md" })
      .expect(200);
    expect(st.body.exists).toBe(true);
    expect(st.body.previewKind).toBe("markdown");

    const preview = await request(app)
      .get(`/api/artifacts/projects/${projectId}/preview`)
      .query({ path: "hello.md" })
      .expect(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.text).toContain("Hello");

    const trav = await request(app)
      .get(`/api/artifacts/projects/${projectId}/preview`)
      .query({ path: "../secret" })
      .expect(200);
    // structured preview error (not thrown as 500)
    expect(trav.body.ok).toBe(false);
    expect(trav.body.errorCode).toMatch(/outside|invalid|not_found/);
  });

  it("registers artifacts, versions, office status, open, detect, reveal, copy, export, package, import", async () => {
    const office = await request(app).get("/api/artifacts/office-status").expect(200);
    expect(office.body.office).toBe(true);

    const created = await request(app)
      .post("/api/artifacts")
      .send({
        projectId,
        relativePath: "hello.md",
        kind: "document",
        title: "Hello Doc",
        origin: "document",
        createdBy: "user",
        tags: ["docs"],
        evidenceLinks: [{ id: "e1", summary: "src" }],
        diffLinks: [{ path: "hello.md", kind: "file" }]
      })
      .expect(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.currentVersion).toBe(1);

    const listed = await request(app).get("/api/artifacts").query({ projectId, tag: "docs" }).expect(200);
    expect(listed.body.artifacts).toHaveLength(1);

    const got = await request(app).get(`/api/artifacts/${created.body.id}`).expect(200);
    expect(got.body.title).toBe("Hello Doc");

    await writeFile(join(workspace, "hello.md"), "# Hello v2\n", "utf8");
    const versioned = await request(app)
      .post(`/api/artifacts/${created.body.id}/versions`)
      .send({ note: "after edit" })
      .expect(201);
    expect(versioned.body.currentVersion).toBe(2);

    const versions = await request(app).get(`/api/artifacts/${created.body.id}/versions`).expect(200);
    expect(versions.body.versions).toHaveLength(2);

    const patched = await request(app)
      .patch(`/api/artifacts/${created.body.id}`)
      .send({ reviewStatus: "accepted", reviewSummary: "ship it" })
      .expect(200);
    expect(patched.body.reviewStatus).toBe("accepted");

    const opened = await request(app)
      .post(`/api/artifacts/projects/${projectId}/open-external`)
      .send({ path: "hello.md", preferred: "auto" })
      .expect(200);
    expect(opened.body.ok).toBe(true);
    expect(opened.body.baseline).toBeTruthy();

    await writeFile(join(workspace, "hello.md"), "# Hello v3\n", "utf8");
    const changed = await request(app)
      .post(`/api/artifacts/projects/${projectId}/detect-changes`)
      .send({ path: "hello.md" })
      .expect(200);
    expect(changed.body.changed).toBe(true);

    const revealed = await request(app)
      .post(`/api/artifacts/projects/${projectId}/reveal`)
      .send({ path: "hello.md" })
      .expect(200);
    expect(revealed.body.ok).toBe(true);

    const copied = await request(app)
      .post(`/api/artifacts/projects/${projectId}/copy-path`)
      .send({ path: "hello.md" })
      .expect(200);
    expect(copied.body.path).toContain("hello.md");

    const exported = await request(app)
      .post(`/api/artifacts/projects/${projectId}/export`)
      .send({
        paths: ["hello.md"],
        destinationDir: exportDir,
        artifactIds: [created.body.id]
      })
      .expect(200);
    expect(exported.body.ok).toBe(true);

    const packed = await request(app)
      .post(`/api/artifacts/projects/${projectId}/package`)
      .send({
        paths: ["hello.md", "docs/a.txt"],
        outputPath: join(exportDir, "bundle.zip")
      })
      .expect(200);
    expect(packed.body.ok).toBe(true);
    expect(packed.body.entryCount).toBeGreaterThanOrEqual(2);

    const imported = await request(app)
      .post("/api/artifacts/runs/run-42/import")
      .send({ projectId })
      .expect(201);
    expect(imported.body.artifacts.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 for unknown artifact", async () => {
    await request(app).get("/api/artifacts/does-not-exist").expect(404);
  });
});
