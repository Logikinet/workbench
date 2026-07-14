import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactBrowserService } from "./artifactBrowserService.js";
import { buildStoredZip } from "./zipOoxml.js";

describe("ArtifactBrowserService (Task 42)", () => {
  let workspace: string;
  let exportDir: string;
  let projectId: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "paw-art-ws-"));
    exportDir = await mkdtemp(join(tmpdir(), "paw-art-ex-"));
    projectId = "proj-1";
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "readme.md"), "# Readme\n\nHello **world**.\n", "utf8");
    await writeFile(join(workspace, "docs", "notes.txt"), "line1\nline2\n", "utf8");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const docXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Paper body</w:t></w:r></w:p></w:body></w:document>`;
    await writeFile(
      join(workspace, "docs", "paper.docx"),
      buildStoredZip([{ name: "word/document.xml", data: Buffer.from(docXml, "utf8") }])
    );

    await writeFile(
      join(workspace, "docs", "tiny.pdf"),
      Buffer.from("%PDF-1.4\n/Type /Pages /Count 1\n/Type /Page\n%%EOF", "latin1")
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  });

  function createService(overrides: Partial<Parameters<typeof ArtifactBrowserService.createMemory>[0]> = {}) {
    return ArtifactBrowserService.createMemory({
      projects: {
        async get(id) {
          if (id !== projectId) throw new Error(`Project ${id} was not found.`);
          return { id: projectId, name: "Demo", workspacePath: workspace };
        }
      },
      openExternal: async ({ absolutePath, relativePath, preferred }) => ({
        ok: true,
        relativePath,
        absolutePath,
        app: preferred === "auto" ? "default" : preferred ?? "default",
        message: "stub open",
        stub: true
      }),
      reveal: async ({ absolutePath, relativePath }) => ({
        ok: true,
        absolutePath,
        relativePath,
        message: "stub reveal",
        stub: true
      }),
      detectOffice: async () => ({
        office: true,
        wps: false,
        detail: "stub office"
      }),
      ...overrides
    });
  }

  it("browses authorized workspace and blocks path traversal", async () => {
    const service = await createService();
    const root = await service.browse(projectId, "");
    expect(root.entries.some((e) => e.name === "readme.md")).toBe(true);
    expect(root.entries.some((e) => e.name === "docs" && e.kind === "directory")).toBe(true);

    const docs = await service.browse(projectId, "docs");
    expect(docs.parentPath).toBe("");
    expect(docs.entries.some((e) => e.name === "notes.txt")).toBe(true);

    await expect(service.browse(projectId, "../")).rejects.toThrow(/traversal|outside|relative/i);
    await expect(service.preview(projectId, "../../etc/passwd")).resolves.toMatchObject({
      ok: false,
      errorCode: "outside_workspace"
    });
  });

  it("previews markdown, code, image, pdf, and docx without rewriting source", async () => {
    const service = await createService();
    const before = await readFile(join(workspace, "readme.md"), "utf8");

    const md = await service.preview(projectId, "readme.md");
    expect(md.ok).toBe(true);
    expect(md.previewKind).toBe("markdown");
    expect(md.text).toContain("Hello");

    const code = await service.preview(projectId, "src/main.ts");
    expect(code.previewKind).toBe("code");
    expect(code.language).toBe("typescript");
    expect(code.text).toContain("export const x");

    const img = await service.preview(projectId, "logo.png");
    expect(img.previewKind).toBe("image");
    expect(img.base64).toBeTruthy();

    const pdf = await service.preview(projectId, "docs/tiny.pdf");
    expect(pdf.previewKind).toBe("pdf");
    expect(pdf.pageCount).toBe(1);

    const docx = await service.preview(projectId, "docs/paper.docx");
    expect(docx.ok).toBe(true);
    expect(docx.previewKind).toBe("docx");
    expect(docx.text).toContain("Paper body");
    expect(docx.html).toContain("Paper body");

    const after = await readFile(join(workspace, "readme.md"), "utf8");
    expect(after).toBe(before);
    const docxBytes = await readFile(join(workspace, "docs", "paper.docx"));
    expect(docxBytes.length).toBeGreaterThan(0);
  });

  it("supports ranged text preview for large-ish content", async () => {
    const service = await createService({ textPreviewBytes: 16 });
    const big = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await writeFile(join(workspace, "big.txt"), big, "utf8");
    const preview = await service.preview(projectId, "big.txt", { offset: 0, limit: 8 });
    expect(preview.ok).toBe(true);
    expect(preview.text).toBe("ABCDEFGH");
    expect(preview.truncated).toBe(true);
    expect(preview.range?.total).toBe(big.length);
  });

  it("registers catalog entries with versions, review, evidence and diff links", async () => {
    const service = await createService();
    const created = await service.registerArtifact({
      projectId,
      relativePath: "docs/notes.txt",
      kind: "document",
      title: "Notes",
      origin: "research",
      createdBy: "firstmate",
      runId: "run-1",
      reviewStatus: "passed",
      evidenceLinks: [{ id: "ev-1", summary: "excerpt", path: "evidence/a.md" }],
      diffLinks: [{ runId: "run-1", path: "docs/notes.txt", kind: "file", summary: "n/a" }],
      sourceLinks: [{ label: "source", url: "https://example.com" }],
      tags: ["research", "notes"]
    });

    expect(created.currentVersion).toBe(1);
    expect(created.versions).toHaveLength(1);
    expect(created.evidenceLinks[0]?.id).toBe("ev-1");

    await writeFile(join(workspace, "docs", "notes.txt"), "changed\n", "utf8");
    const v2 = await service.addVersion(created.id, { note: "edited in Office", createdBy: "user" });
    expect(v2.currentVersion).toBe(2);
    expect(v2.versions).toHaveLength(2);

    // unchanged content → no new version
    const same = await service.addVersion(created.id);
    expect(same.currentVersion).toBe(2);

    const listed = service.listArtifacts({ projectId, tag: "research", q: "notes" });
    expect(listed).toHaveLength(1);

    const updated = await service.updateArtifact(created.id, {
      reviewStatus: "accepted",
      tags: ["research", "final"]
    });
    expect(updated.reviewStatus).toBe("accepted");
    expect(updated.tags).toContain("final");
  });

  it("imports run artifacts with worktree diff links", async () => {
    const service = await createService({
      runs: {
        async get(runId) {
          return {
            id: runId,
            todoId: "todo-1",
            status: "completed",
            artifacts: [
              {
                id: "a1",
                path: "src/main.ts",
                kind: "worktree-file",
                createdAt: "2026-07-15T00:00:00.000Z",
                evidence: {
                  source: "codex-worktree",
                  diff: "diff --git a/src/main.ts",
                  changedFiles: ["src/main.ts"],
                  summary: "1 file changed"
                }
              }
            ],
            reviews: [{ id: "r1", status: "passed", summary: "ok" }]
          };
        }
      }
    });

    const imported = await service.importRunArtifacts("run-9", projectId);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.origin).toBe("codex");
    expect(imported[0]!.diffLinks[0]?.kind).toBe("worktree");
    expect(imported[0]!.reviewStatus).toBe("passed");

    // idempotent
    const again = await service.importRunArtifacts("run-9", projectId);
    expect(again).toHaveLength(1);
    expect(service.listArtifacts({ runId: "run-9" })).toHaveLength(1);
  });

  it("opens externally, detects changes, reveals, copies path, exports and packages", async () => {
    const service = await createService();
    const opened = await service.openExternal(projectId, "docs/notes.txt", "office");
    expect(opened.ok).toBe(true);
    expect(opened.baseline?.contentHash).toBeTruthy();

    let detect = await service.detectChanges(projectId, "docs/notes.txt");
    expect(detect.changed).toBe(false);

    await writeFile(join(workspace, "docs", "notes.txt"), "after office save\n", "utf8");
    detect = await service.detectChanges(projectId, "docs/notes.txt");
    expect(detect.changed).toBe(true);

    const revealed = await service.reveal(projectId, "docs/notes.txt");
    expect(revealed.ok).toBe(true);

    const copied = await service.copyPath(projectId, "docs/notes.txt");
    expect(copied.absolutePath).toContain("notes.txt");
    expect(copied.relativePath).toBe("docs/notes.txt");

    const exported = await service.exportFiles({
      projectId,
      paths: ["docs/notes.txt", "readme.md"],
      destinationDir: exportDir,
      mode: "copy"
    });
    expect(exported.ok).toBe(true);
    expect(exported.files.length).toBe(2);
    expect(exported.manifestPath).toBeTruthy();
    const manifest = JSON.parse(await readFile(exported.manifestPath!, "utf8"));
    expect(manifest.files).toHaveLength(2);

    const zipPath = join(exportDir, "pack.zip");
    const packed = await service.packageFiles({
      projectId,
      paths: ["readme.md", "docs/notes.txt"],
      outputPath: zipPath,
      includeManifest: true
    });
    expect(packed.ok).toBe(true);
    expect(packed.entryCount).toBeGreaterThanOrEqual(3);
    const zipBuf = await readFile(zipPath);
    expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50);
  });

  it("persists catalog to disk", async () => {
    const catalogPath = join(exportDir, "artifacts.json");
    const service = await ArtifactBrowserService.open({
      catalogPath,
      projects: {
        async get() {
          return { id: projectId, name: "Demo", workspacePath: workspace };
        }
      }
    });
    await service.registerArtifact({
      projectId,
      relativePath: "readme.md",
      kind: "document",
      title: "Readme"
    });

    const reopened = await ArtifactBrowserService.open({
      catalogPath,
      projects: {
        async get() {
          return { id: projectId, name: "Demo", workspacePath: workspace };
        }
      }
    });
    expect(reopened.listArtifacts()).toHaveLength(1);
    expect(reopened.listArtifacts()[0]!.title).toBe("Readme");
  });

  it("preview failure does not touch original file", async () => {
    const service = await createService();
    // Corrupt docx (not a zip)
    await writeFile(join(workspace, "docs", "bad.docx"), "not-a-zip", "utf8");
    const before = await readFile(join(workspace, "docs", "bad.docx"));
    const preview = await service.preview(projectId, "docs/bad.docx");
    // may ok with empty extract or parse_failed — either way no rewrite
    const after = await readFile(join(workspace, "docs", "bad.docx"));
    expect(Buffer.compare(before, after)).toBe(0);
    expect(preview.previewKind).toBe("docx");
  });

  it("office status uses injected detector", async () => {
    const detectOffice = vi.fn(async () => ({
      office: false,
      wps: true,
      detail: "WPS only"
    }));
    const service = await createService({ detectOffice });
    const status = await service.officeStatus();
    expect(status.wps).toBe(true);
    expect(detectOffice).toHaveBeenCalled();
  });
});
