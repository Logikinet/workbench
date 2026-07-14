import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { createEvidence } from "../research/evidence.js";
import { buildMinimalPdf } from "../research/pdfImport.js";
import { DocumentService } from "./documentService.js";
import { buildZipStore } from "./exportFormats.js";

describe("DocumentService integration (task 33)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const now = () => new Date("2026-04-06T15:00:00.000Z");

  async function open(model?: FakeModelProvider) {
    const dir = await mkdtemp(join(tmpdir(), "paw-docs-"));
    dirs.push(dir);
    const provider =
      model
      ?? new FakeModelProvider({
        successContents: [
          // outline
          JSON.stringify({
            title: "Widget Productivity Paper",
            summary: "Evidence-bound paper",
            sections: [
              {
                title: "Introduction",
                summary: "Background and goal",
                acceptanceCriteria: ["Cites Evidence", "Uses project facts"],
                missingData: []
              },
              {
                title: "Findings",
                summary: "What sources show",
                acceptanceCriteria: ["No invented stats"],
                missingData: ["Exact multi-site replication count"]
              }
            ],
            missingDataList: ["Exact multi-site replication count"],
            acceptanceCriteria: ["User approved outline"]
          }),
          // chapter 1
          JSON.stringify({
            body: "Widgets increase productivity in office trials [Lee2025]. The TypeScript monorepo implements this workflow.",
            citationKeys: ["Lee2025"],
            terminology: { Widget: "Widget" },
            dataPoints: [{ key: "finding", value: "increase productivity" }]
          }),
          // chapter 2
          JSON.stringify({
            body: "Evidence shows widgets help [Lee2025]. We do not invent multi-site counts.",
            citationKeys: ["Lee2025"],
            terminology: { Widget: "Widget" },
            dataPoints: [{ key: "finding", value: "increase productivity" }]
          })
        ]
      });

    const service = await DocumentService.open({
      statePath: join(dir, "documents.json"),
      model: provider,
      exportDir: join(dir, "exports"),
      now
    });
    return { service, dir, provider };
  }

  it("runs full document workflow: materials → outline approve → write → citations → export → external edit", async () => {
    const { service, dir } = await open();

    const session = await service.createSession({
      title: "Widgets",
      goal: "Write a short paper on widget productivity",
      runId: "run-33",
      projectFacts: ["TypeScript monorepo"],
      bibliographyStyle: "apa"
    });
    expect(session.status).toBe("collecting_materials");
    expect(session.materials.some((m) => m.kind === "project_fact")).toBe(true);

    // Markdown template + user material
    await service.importMarkdown(session.id, {
      text: "# Paper Template\n\n## Abstract\n## Body",
      kind: "template"
    });
    await service.importMarkdown(session.id, {
      text: "User note: focus on office trials.",
      kind: "user_material",
      title: "User notes"
    });

    // DOCX template
    const docXml =
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>Institutional header template</w:t></w:r></w:p></w:body></w:document>`;
    const docx = buildZipStore([{ name: "word/document.xml", data: Buffer.from(docXml, "utf8") }]);
    await service.importDocxBytes(session.id, docx, { title: "Header", kind: "template" });

    // PDF material
    const pdf = buildMinimalPdf({ title: "Prior paper", author: "Ada", pageCount: 1 });
    await service.importPdfBytes(session.id, pdf, {
      title: "Prior paper",
      kind: "user_material",
      pageTexts: [{ page: 1, text: "Prior work on tools." }]
    });

    // Research Evidence
    const evidence = createEvidence({
      title: "Widget productivity study",
      source: "https://research.example/widgets",
      excerpt: "Widgets increase productivity in office trials.",
      origin: "web",
      author: "Lee",
      publishedAt: "2025-05-01T00:00:00.000Z",
      now
    });
    let current = await service.importEvidence(session.id, [evidence]);
    expect(current.evidence).toHaveLength(1);
    expect(current.materials.some((m) => m.kind === "evidence")).toBe(true);
    expect(current.materials.every((m) => m.kind === "generated" || m.contentOrigin === "original")).toBe(
      true
    );

    // Outline — awaiting approval; writing blocked until approved
    current = await service.generateOutline(session.id);
    expect(current.status).toBe("awaiting_outline_approval");
    expect(current.outline?.sections.length).toBe(2);

    const sectionId = current.outline!.sections[0]!.id;
    await expect(service.writeChapter(session.id, sectionId)).rejects.toThrow(/approved/i);

    current = await service.approveOutline(session.id);
    expect(current.status).toBe("writing");
    expect(current.outline?.status).toBe("approved");

    // Bind evidence ids onto sections for grounding (outline generator may not know ids)
    // Service already generated outline; re-bind by writing with session evidence available.
    const written1 = await service.writeChapter(session.id, sectionId);
    expect(written1.blocked).toBe(false);
    expect(written1.chapter.versions[0]!.contentOrigin).toBe("generated");

    const section2 = (await service.getSession(session.id)).outline!.sections[1]!.id;
    const written2 = await service.writeChapter(session.id, section2);
    expect(written2.blocked).toBe(false);

    // Version compare after revision
    const revModel = new FakeModelProvider({
      successContent: JSON.stringify({
        body: "Revised intro: Widgets increase productivity in office trials [Lee2025]. Monorepo context retained.",
        citationKeys: ["Lee2025"],
        terminology: { Widget: "Widget" },
        dataPoints: [{ key: "finding", value: "increase productivity" }]
      })
    });
    const service2 = await DocumentService.open({
      statePath: join(dir, "documents.json"),
      model: revModel,
      exportDir: join(dir, "exports"),
      now: () => new Date("2026-04-06T16:00:00.000Z")
    });
    const revised = await service2.writeChapter(session.id, sectionId, {
      revisionNote: "Tighten opening"
    });
    expect(revised.chapter.currentVersion).toBe(2);
    const diff = service2.compareVersions(session.id, revised.chapter.id, 1, 2);
    expect(diff.addedLines.length + diff.removedLines.length).toBeGreaterThan(0);

    const consistency = await service2.runConsistencyCheck(session.id);
    expect(consistency.ok).toBe(true);

    const cite = await service2.checkCitations(session.id);
    expect(cite.ok).toBe(true);
    expect(cite.bibliography).toMatch(/Lee|References|参考文献/);

    await service2.setBibliographyStyle(session.id, "ieee");
    const ieee = await service2.checkCitations(session.id);
    expect(ieee.style).toBe("ieee");

    const exported = await service2.exportAll(session.id);
    expect(exported.artifacts).toHaveLength(3);
    expect(exported.markdown).toContain("Widget");
    expect(exported.docx[0]).toBe(0x50);
    expect(exported.pdf.subarray(0, 5).toString("utf8")).toBe("%PDF-");

    const mdPath = exported.artifacts.find((a) => a.format === "markdown")!.path;
    const onDisk = await readFile(mdPath, "utf8");
    expect(onDisk).toContain("Widgets increase productivity");

    // External edit detection
    let after = await service2.detectExternalEdits(session.id);
    expect(after.anyChanged).toBe(false);

    await writeFile(mdPath, onDisk + "\n\n<!-- edited in WPS -->\n", "utf8");
    after = await service2.detectExternalEdits(session.id);
    expect(after.anyChanged).toBe(true);
    expect(after.rereviewRequired).toBe(true);
    expect(after.session.status).toBe("needs_rereview");

    // Persistence
    const reopened = await DocumentService.open({
      statePath: join(dir, "documents.json"),
      now
    });
    const loaded = await reopened.getSession(session.id);
    expect(loaded.exports.length).toBe(3);
    expect(loaded.chapters.length).toBe(2);
  });

  it("blocks ungrounded fabricated chapter content", async () => {
    const model = new FakeModelProvider({
      successContents: [
        JSON.stringify({
          title: "T",
          summary: "S",
          sections: [{ title: "Intro", summary: "s", acceptanceCriteria: [], missingData: [] }]
        }),
        JSON.stringify({
          body: "We won the Nobel Prize with 99.7% accuracy (n=5000 participants) [Ghost2099].",
          citationKeys: ["Ghost2099"]
        })
      ]
    });
    const { service } = await open(model);
    const session = await service.createSession({
      title: "Bad",
      goal: "Should not invent",
      projectFacts: ["Local app only"]
    });
    await service.generateOutline(session.id);
    await service.approveOutline(session.id);
    const sec = (await service.getSession(session.id)).outline!.sections[0]!.id;
    const result = await service.writeChapter(session.id, sec);
    expect(result.blocked).toBe(true);
    expect(result.blockReasons.length).toBeGreaterThan(0);
  });

  it("rejects outline until user approves", async () => {
    const { service } = await open();
    const session = await service.createSession({ title: "T", goal: "G" });
    await service.generateOutline(session.id);
    const rejected = await service.rejectOutline(session.id, "Need methods section");
    expect(rejected.outline?.status).toBe("rejected");
    expect(rejected.status).toBe("outlining");
  });
});
