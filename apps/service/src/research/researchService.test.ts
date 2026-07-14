import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceBindingError } from "./evidence.js";
import {
  buildMinimalPdf,
  FakePdfPageExtractor
} from "./pdfImport.js";
import {
  EVIDENCE_CATALOG_PATH,
  RESEARCH_MD_PATH,
  SOURCES_JSON_PATH
} from "./researchArtifacts.js";
import { ResearchService } from "./researchService.js";
import { FakeWebFetch, FakeWebSearch } from "./webTools.js";

describe("ResearchService integration (task 32)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function openService(extra?: {
    search?: FakeWebSearch;
    fetch?: FakeWebFetch;
    pdfExtractor?: FakePdfPageExtractor;
    writer?: Map<string, string>;
  }) {
    const dir = await mkdtemp(join(tmpdir(), "paw-research-"));
    dirs.push(dir);
    const search =
      extra?.search
      ?? new FakeWebSearch().seed([
        {
          title: "Widget productivity study",
          url: "https://research.example/widgets",
          snippet: "Widgets increase productivity in office trials.",
          author: "Lee",
          publishedAt: "2025-05-01T00:00:00.000Z"
        },
        {
          title: "Skeptical blog",
          url: "https://blog.example/nope",
          snippet: "Widgets do not increase productivity according to critics.",
          author: "Anon"
        }
      ]);
    const fetch =
      extra?.fetch
      ?? new FakeWebFetch()
        .seed("https://research.example/widgets", {
          title: "Widget productivity study",
          author: "Lee",
          publishedAt: "2025-05-01T00:00:00.000Z",
          text: "Full text: Widgets increase productivity in office trials with control groups. Effect size is meaningful."
        })
        .seed("https://blog.example/nope", {
          title: "Skeptical blog",
          text: "Opinion: Widgets do not increase productivity according to critics and informal polls."
        });

    const files = extra?.writer ?? new Map<string, string>();
    const service = await ResearchService.open({
      statePath: join(dir, "research.json"),
      search,
      fetch,
      pdfExtractor: extra?.pdfExtractor,
      now: () => new Date("2026-04-01T12:00:00.000Z"),
      artifactWriter: {
        async writeFile(path, content) {
          files.set(path, content);
        }
      }
    });
    return { service, dir, search, fetch, files };
  }

  it("runs evidence-first flow: search, fetch, claims, aggregate, artifacts, review", async () => {
    const { service, files } = await openService();

    const session = await service.createSession({
      title: "Widget productivity",
      goal: "Do widgets increase productivity?",
      runId: "run-1",
      forceEvidenceMode: true
    });
    expect(session.subQuestions.length).toBeGreaterThanOrEqual(2);
    expect(session.steps.length).toBe(session.subQuestions.length);
    expect(session.forceEvidenceMode).toBe(true);

    await service.beginGathering(session.id);

    const searched = await service.searchWeb(session.id, "widgets", {
      stepId: session.steps[0]?.id
    });
    expect(searched.hits.length).toBeGreaterThanOrEqual(1);
    expect(searched.evidenceIds.length).toBe(searched.hits.length);

    const fetched = await service.fetchPage(session.id, "https://research.example/widgets", {
      stepId: session.steps[0]?.id
    });
    expect(fetched.evidence.origin).toBe("web");
    expect(fetched.evidence.excerpt).toMatch(/productivity/i);
    expect(fetched.evidence.author).toBe("Lee");

    const fetchedCon = await service.fetchPage(session.id, "https://blog.example/nope");
    expect(fetchedCon.evidence.excerpt).toMatch(/do not increase/i);

    // Flag low-trust blog
    await service.flagEvidence(session.id, fetchedCon.evidence.id, ["low_trust"]);

    const fact = await service.addClaim(session.id, {
      text: "Widgets increase productivity in office trials",
      kind: "fact",
      evidenceIds: [fetched.evidence.id]
    });
    expect(fact.claim.originMarker).toBe("source_backed");
    expect(fact.claim.finalFactEligible).toBe(true);

    const inference = await service.addClaim(session.id, {
      text: "Widgets might become standard office equipment.",
      kind: "ai_inference"
    });
    expect(inference.claim.originMarker).toBe("ai_inference");
    expect(inference.claim.finalFactEligible).toBe(false);

    await service.addUserMaterial(session.id, {
      title: "My notes",
      text: "User believes widgets help personally."
    });

    // Missing evidence binding must fail under force mode
    await expect(
      service.addClaim(session.id, {
        text: "Unbacked conclusion",
        kind: "conclusion"
      })
    ).rejects.toBeInstanceOf(EvidenceBindingError);

    for (const step of session.steps) {
      await service.completeResearchStep(session.id, step.id);
    }

    const agg = await service.aggregate(session.id);
    expect(agg.session.aggregated).toBe(true);
    expect(agg.session.sources.length).toBeGreaterThanOrEqual(1);

    const artifacts = await service.produceArtifacts(session.id);
    expect(artifacts.artifacts.map((a) => a.path).sort()).toEqual(
      [EVIDENCE_CATALOG_PATH, RESEARCH_MD_PATH, SOURCES_JSON_PATH].sort()
    );
    expect(files.get(RESEARCH_MD_PATH)).toMatch(/Widget productivity/);
    expect(files.get(RESEARCH_MD_PATH)).toMatch(/AI 推断|AI inferences/i);
    expect(files.get(SOURCES_JSON_PATH)).toMatch(/research\.example/);
    expect(files.get(EVIDENCE_CATALOG_PATH)).toMatch(/Evidence catalog/);

    const review = await service.checkEvidence(session.id);
    expect(review.ok).toBe(true);
    expect(review.insufficientEvidence).toBe(false);

    const final = await service.finalizeIfEvidenceOk(session.id);
    expect(final.passed).toBe(true);
    expect(final.session.status).toBe("completed");
  });

  it("records unreachable pages as flagged evidence, not final facts", async () => {
    const fetch = new FakeWebFetch(); // empty
    const { service } = await openService({ fetch });
    const session = await service.createSession({
      title: "T",
      goal: "G?",
      forceEvidenceMode: true
    });
    const { evidence } = await service.fetchPage(session.id, "https://missing.example/x");
    expect(evidence.qualityFlags).toContain("unreachable");
    expect(evidence.status).toBe("flagged");

    await expect(
      service.addClaim(session.id, {
        text: "Something about missing page content here",
        kind: "fact",
        evidenceIds: [evidence.id]
      })
    ).resolves.toMatchObject({
      claim: { finalFactEligible: false }
    });
  });

  it("imports PDF with metadata into evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paw-pdf-svc-"));
    dirs.push(dir);
    const pdfPath = join(dir, "paper.pdf");
    await writeFile(
      pdfPath,
      buildMinimalPdf({ title: "PDF Survey", author: "Hopper", pageCount: 2 })
    );
    const extractor = new FakePdfPageExtractor().seed(pdfPath, [
      { page: 1, text: "PDF Survey abstract: widgets increase productivity metrics." },
      { page: 2, text: "References and appendix." }
    ]);
    const { service } = await openService({ pdfExtractor: extractor });
    const session = await service.createSession({ title: "PDF", goal: "Import paper" });
    const { evidence } = await service.importPdfFile(session.id, pdfPath);
    expect(evidence.length).toBe(2);
    expect(evidence[0]?.origin).toBe("pdf");
    expect(evidence[0]?.title).toBe("PDF Survey");
    expect(evidence[0]?.author).toBe("Hopper");
    expect(evidence[0]?.location?.page).toBe(1);
    expect(evidence[0]?.excerpt).toMatch(/widgets increase productivity/);
  });

  it("creative mode allows unbound conclusions", async () => {
    const { service } = await openService();
    const session = await service.createSession({
      title: "Brainstorm",
      goal: "Ideas only",
      forceEvidenceMode: false
    });
    const { claim } = await service.addClaim(session.id, {
      text: "Wild creative idea",
      kind: "conclusion"
    });
    expect(claim.evidenceIds).toEqual([]);
    const agg = await service.aggregate(session.id);
    await service.produceArtifacts(agg.session.id);
    const review = await service.checkEvidence(session.id);
    expect(review.ok).toBe(true);
  });

  it("review fails without sufficient supporting evidence", async () => {
    const fetch = new FakeWebFetch().seed("https://ex.com/a", {
      title: "A",
      text: "Totally unrelated content about marine biology and coral reefs."
    });
    const { service } = await openService({ fetch });
    const session = await service.createSession({
      title: "Bad cite",
      goal: "Test reviewer gate",
      forceEvidenceMode: true
    });
    const { evidence } = await service.fetchPage(session.id, "https://ex.com/a");
    await service.addClaim(session.id, {
      text: "Widgets increase productivity substantially",
      kind: "fact",
      evidenceIds: [evidence.id]
    });
    await service.aggregate(session.id);
    await service.produceArtifacts(session.id);
    const review = await service.checkEvidence(session.id);
    expect(review.ok).toBe(false);
    expect(review.insufficientEvidence).toBe(true);
    const final = await service.finalizeIfEvidenceOk(session.id);
    expect(final.passed).toBe(false);
    expect(final.session.status).not.toBe("completed");
  });

  it("persists sessions to statePath", async () => {
    const { service, dir } = await openService();
    const created = await service.createSession({ title: "Persist", goal: "Check disk" });
    const reopened = await ResearchService.open({ statePath: join(dir, "research.json") });
    const loaded = await reopened.getSession(created.id);
    expect(loaded.title).toBe("Persist");
  });
});
