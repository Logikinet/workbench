import { describe, expect, it } from "vitest";
import {
  canUseAsFinalFact,
  createClaim,
  createEvidence,
  EvidenceBindingError,
  evidenceSupportsClaim,
  markEvidence,
  originMarkerForClaim,
  reevaluateClaimEligibility
} from "./evidence.js";

describe("evidence binding (task 32)", () => {
  const now = () => new Date("2026-03-01T00:00:00.000Z");

  it("stores title, author, source, times, excerpt and location", () => {
    const e = createEvidence({
      title: "Widget Study",
      author: "Ada",
      source: "https://ex.com/study",
      publishedAt: "2025-01-01T00:00:00.000Z",
      excerpt: "Widgets increased productivity by 20%.",
      origin: "web",
      location: { page: 2, charStart: 10, charEnd: 40, anchor: "§Results" },
      now
    });
    expect(e.title).toBe("Widget Study");
    expect(e.author).toBe("Ada");
    expect(e.source).toBe("https://ex.com/study");
    expect(e.publishedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(e.accessedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(e.excerpt).toMatch(/productivity/);
    expect(e.location?.page).toBe(2);
    expect(e.location?.anchor).toBe("§Results");
    expect(e.contentHash).toHaveLength(32);
  });

  it("uses distinct origin markers for AI inference vs user materials vs sources", () => {
    expect(originMarkerForClaim("fact")).toBe("source_backed");
    expect(originMarkerForClaim("conclusion")).toBe("source_backed");
    expect(originMarkerForClaim("ai_inference")).toBe("ai_inference");
    expect(originMarkerForClaim("user_material")).toBe("user_material");

    const ai = createClaim({
      text: "Perhaps widgets will dominate.",
      kind: "ai_inference",
      forceEvidenceMode: true,
      now
    });
    expect(ai.originMarker).toBe("ai_inference");
    expect(ai.finalFactEligible).toBe(false);

    const user = createClaim({
      text: "My notes say X.",
      kind: "user_material",
      forceEvidenceMode: true,
      now
    });
    expect(user.originMarker).toBe("user_material");
    expect(user.finalFactEligible).toBe(false);
  });

  it("requires Evidence binding for facts/conclusions when forceEvidenceMode is on", () => {
    expect(() =>
      createClaim({ text: "Widgets are useful.", kind: "fact", forceEvidenceMode: true, now })
    ).toThrow(EvidenceBindingError);

    const e = createEvidence({
      title: "T",
      source: "https://ex.com/t",
      excerpt: "Widgets are useful devices for testing.",
      origin: "web",
      now
    });
    const claim = createClaim({
      text: "Widgets are useful devices",
      kind: "fact",
      evidenceIds: [e.id],
      evidencePool: [e],
      forceEvidenceMode: true,
      now
    });
    expect(claim.finalFactEligible).toBe(true);
    expect(claim.evidenceIds).toEqual([e.id]);
  });

  it("allows unbound claims when forceEvidenceMode is off (creative tasks)", () => {
    const claim = createClaim({
      text: "A creative hypothesis.",
      kind: "conclusion",
      forceEvidenceMode: false,
      now
    });
    expect(claim.evidenceIds).toEqual([]);
    expect(claim.finalFactEligible).toBe(true);
  });

  it("marks duplicate/invalid/low_trust so they are not automatic final facts", () => {
    const base = createEvidence({
      title: "Low",
      source: "https://ex.com/low",
      excerpt: "Something about widgets.",
      origin: "web",
      now
    });
    expect(canUseAsFinalFact(base)).toBe(true);

    const flagged = markEvidence(base, ["low_trust", "duplicate"]);
    expect(flagged.status).toBe("flagged");
    expect(canUseAsFinalFact(flagged)).toBe(false);

    const invalid = markEvidence(base, ["invalid"], "excluded");
    expect(canUseAsFinalFact(invalid)).toBe(false);

    const aiEv = createEvidence({
      title: "AI",
      source: "ai://note",
      excerpt: "guess",
      origin: "ai_inference",
      now
    });
    expect(canUseAsFinalFact(aiEv)).toBe(false);
  });

  it("reevaluates claim eligibility after evidence quality changes", () => {
    const e = createEvidence({
      title: "T",
      source: "https://ex.com/t",
      excerpt: "Widgets raise output significantly in trials.",
      origin: "web",
      now
    });
    let claim = createClaim({
      text: "Widgets raise output significantly",
      kind: "fact",
      evidenceIds: [e.id],
      evidencePool: [e],
      forceEvidenceMode: true,
      now
    });
    expect(claim.finalFactEligible).toBe(true);

    const bad = markEvidence(e, ["stale", "low_trust"]);
    claim = reevaluateClaimEligibility(claim, [bad], true);
    expect(claim.finalFactEligible).toBe(false);
  });

  it("detects whether evidence excerpt supports a claim", () => {
    const e = createEvidence({
      title: "T",
      source: "https://ex.com/t",
      excerpt: "Controlled trials show widgets increase productivity by twenty percent.",
      body: "Controlled trials show widgets increase productivity by twenty percent in offices.",
      origin: "web",
      now
    });
    expect(evidenceSupportsClaim(e, "widgets increase productivity")).toBe(true);
    expect(evidenceSupportsClaim(e, "quantum entanglement in black holes")).toBe(false);
  });
});
