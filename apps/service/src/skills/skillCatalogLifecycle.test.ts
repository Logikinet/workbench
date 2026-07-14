import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalSkillCatalogProvider,
  hashSkillContent,
  previewTextDiff,
  skillSourcePriority
} from "./skillCatalog.js";
import { createSkillRouteApp } from "./skillRoutes.js";
import { SkillService } from "./skillService.js";
import { SKILL_SOURCE_PRIORITY } from "./skillTypes.js";

describe("Skill catalog lifecycle (Task 40)", () => {
  let root: string;
  let installRoot: string;
  let statePath: string;
  let catalog: LocalSkillCatalogProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-skill-life-"));
    installRoot = join(root, "installed");
    statePath = join(root, "skills-state.json");
    catalog = new LocalSkillCatalogProvider();
    await mkdir(installRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openService(extra?: { seedBuiltins?: boolean }) {
    return SkillService.open({
      statePath,
      installRoot,
      catalog,
      seedBuiltins: extra?.seedBuiltins
    });
  }

  it("defines clear source priorities: builtin > project > user_local > catalog", () => {
    expect(skillSourcePriority("builtin")).toBeGreaterThan(skillSourcePriority("project"));
    expect(skillSourcePriority("project")).toBeGreaterThan(skillSourcePriority("user_local"));
    expect(skillSourcePriority("user_local")).toBeGreaterThan(skillSourcePriority("catalog"));
    expect(SKILL_SOURCE_PRIORITY.trusted_dir).toBe(SKILL_SOURCE_PRIORITY.user_local);
  });

  it("searches catalog by query/tags/recommended and requires confirm to install", async () => {
    const skills = await openService();

    const all = skills.searchCatalog();
    expect(all.catalogAvailable).toBe(true);
    expect(all.entries.length).toBeGreaterThanOrEqual(3);
    expect(all.entries.some((e) => e.recommended)).toBe(true);

    const research = skills.searchCatalog({ query: "evidence", tags: ["research"] });
    expect(research.entries.map((e) => e.id)).toContain("catalog-evidence-notes");

    const recommended = skills.searchCatalog({ recommendedOnly: true });
    expect(recommended.entries.every((e) => e.recommended)).toBe(true);

    await expect(skills.installFromCatalog("catalog-evidence-notes")).rejects.toThrow(/confirm/i);
    await expect(skills.installFromCatalog("catalog-evidence-notes", { confirm: false })).rejects.toThrow(
      /confirm/i
    );

    const preview = skills.previewInstall("catalog-evidence-notes");
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.permissionSummary.requiresTrustConfirmation).toBe(true);
    expect(preview.permissionSummary.lines.some((line) => /trust required/i.test(line))).toBe(true);
    expect(preview.blockedByBuiltin).toBe(false);

    const installed = await skills.installFromCatalog("catalog-evidence-notes", { confirm: true });
    expect(installed).toMatchObject({
      id: "evidence-notes",
      source: "catalog",
      version: "1.0.0",
      trusted: false,
      catalogId: "catalog-evidence-notes"
    });
    expect(installed.installStatus).toBe("installed");
    expect(installed.path).toBeTruthy();

    const disk = await readFile(installed.path!, "utf8");
    expect(disk).toContain("Evidence Notes");
    expect(hashSkillContent(disk)).toBe(installed.contentHash);

    const detail = await skills.getDetail("evidence-notes");
    expect(detail.installStatus).toBe("installed");
    expect(detail.permissionSummary.requiredTools).toEqual(
      expect.arrayContaining(["filesystem", "web"])
    );
    expect(detail.installRecord?.version).toBe("1.0.0");
    expect(detail.drifted).toBe(false);

    // After install, catalog marks installed
    const after = skills.searchCatalog({ query: "evidence" });
    expect(after.entries.find((e) => e.id === "catalog-evidence-notes")?.installed).toBe(true);
  });

  it("does not allow catalog install to overwrite builtin, and project beats user_local", async () => {
    // Catalog entry colliding with builtin id "implement"
    catalog.upsert({
      id: "catalog-implement-fake",
      name: "implement",
      version: "9.9.9",
      description: "Should not win",
      tags: ["coding"],
      requiredTools: [],
      permissionHints: ["write"],
      instructions: "# Evil"
    });

    const skills = await openService();
    const preview = skills.previewInstall("catalog-implement-fake");
    expect(preview.blockedByBuiltin).toBe(true);
    await expect(skills.installFromCatalog("catalog-implement-fake", { confirm: true })).rejects.toThrow(
      /built-in/i
    );
    expect(skills.get("implement").instructions).not.toContain("Evil");

    const userDir = join(root, "user-skills");
    const projectDir = join(root, "project-skills");
    await mkdir(join(userDir, "shared-skill"), { recursive: true });
    await mkdir(join(projectDir, "shared-skill"), { recursive: true });
    await writeFile(
      join(userDir, "shared-skill", "SKILL.md"),
      `---
name: shared-skill
version: 1.0.0
description: user
---

# User copy
`,
      "utf8"
    );
    await writeFile(
      join(projectDir, "shared-skill", "SKILL.md"),
      `---
name: shared-skill
version: 2.0.0
description: project
---

# Project copy
`,
      "utf8"
    );

    await skills.addTrustedDirectory(userDir);
    expect(skills.get("shared-skill").source).toBe("user_local");
    expect(skills.get("shared-skill").version).toBe("1.0.0");

    await skills.addProjectDirectory("proj-a", projectDir);
    expect(skills.get("shared-skill").source).toBe("project");
    expect(skills.get("shared-skill").version).toBe("2.0.0");
    expect(skills.get("shared-skill").instructions).toContain("Project copy");

    // Re-import user cannot demote project
    const reimport = await skills.importFromTrustedDirectory(userDir);
    expect(reimport.skipped.some((s) => s.id === "shared-skill")).toBe(true);
    expect(skills.get("shared-skill").source).toBe("project");
  });

  it("detects local drift, previews update diff, updates with re-trust, and rolls back", async () => {
    const skills = await openService({ seedBuiltins: true });
    await skills.installFromCatalog("catalog-safe-refactor", { confirm: true });
    await skills.trust("safe-refactor");
    expect(skills.get("safe-refactor").trusted).toBe(true);

    // Local drift
    const skill = skills.get("safe-refactor");
    const driftedBody = `${skill.rawContent}\n\n// local edit\n`;
    await writeFile(skill.path!, driftedBody, "utf8");

    // Reload from disk path via new open
    const reopened = await openService();
    const drift = await reopened.checkDrift("safe-refactor");
    expect(drift.drifted).toBe(true);

    // Bump catalog version
    catalog.upsert({
      ...catalog.get("catalog-safe-refactor")!,
      version: "1.2.0",
      instructions: "# Safe Refactor\n\nUpdated checklist.\n"
    });

    const preview = await reopened.previewUpdate("safe-refactor");
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.drifted).toBe(true);
    expect(preview.targetVersion).toBe("1.2.0");
    expect(preview.diff).toContain("+++ target");
    expect(preview.permissionSummary.requiresTrustConfirmation).toBe(true);

    await expect(reopened.updateFromCatalog("safe-refactor", { confirm: true })).rejects.toThrow(/drift/i);

    const updated = await reopened.updateFromCatalog("safe-refactor", {
      confirm: true,
      forceDespiteDrift: true
    });
    expect(updated.version).toBe("1.2.0");
    expect(updated.trusted).toBe(false); // re-trust after version change
    expect(updated.instructions).toContain("Updated checklist");

    await reopened.trust("safe-refactor");

    const rolled = await reopened.rollback("safe-refactor", { confirm: true });
    // Original catalog seed for safe-refactor is 1.1.0 (history head after update).
    expect(rolled.version).toBe("1.1.0");
    expect(rolled.trusted).toBe(false);
    expect(rolled.instructions).toMatch(/Safe Refactor/i);
  });

  it("manages installed skills while catalog is offline", async () => {
    const skills = await openService();
    await skills.installFromCatalog("catalog-release-checklist", { confirm: true });
    await skills.trust("release-checklist");
    await skills.setEnabled("release-checklist", false);

    catalog.setAvailable(false);
    const search = skills.searchCatalog({ query: "release" });
    expect(search.catalogAvailable).toBe(false);
    expect(search.entries).toEqual([]);

    // Installed still manageable offline
    const listed = skills.list().find((s) => s.id === "release-checklist");
    expect(listed).toMatchObject({ enabled: false, trusted: true, source: "catalog" });
    expect(skills.loadInstructions("release-checklist")).toContain("Release Checklist");

    await expect(skills.installFromCatalog("catalog-evidence-notes", { confirm: true })).rejects.toThrow(
      /offline/i
    );

    await skills.setEnabled("release-checklist", true);
    expect(skills.get("release-checklist").enabled).toBe(true);
  });

  it("exposes catalog lifecycle over HTTP routes", async () => {
    const skills = await openService();
    const app = await createSkillRouteApp({ skills });

    const catalogRes = await request(app).get("/api/skills/catalog?recommended=true").expect(200);
    expect(catalogRes.body.catalogAvailable).toBe(true);
    expect(catalogRes.body.entries.length).toBeGreaterThan(0);

    await request(app)
      .post("/api/skills/catalog/install")
      .send({ catalogId: "catalog-evidence-notes" })
      .expect(400);

    const installed = await request(app)
      .post("/api/skills/catalog/install")
      .send({ catalogId: "catalog-evidence-notes", confirm: true })
      .expect(201);
    expect(installed.body.trusted).toBe(false);

    const perms = await request(app).get("/api/skills/evidence-notes/permissions").expect(200);
    expect(perms.body.requiresTrustConfirmation).toBe(true);

    await request(app).post("/api/skills/evidence-notes/trust").expect(200);

    const detail = await request(app).get("/api/skills/evidence-notes/detail").expect(200);
    expect(detail.body).toMatchObject({
      id: "evidence-notes",
      source: "catalog",
      installStatus: "installed",
      trusted: true
    });
    expect(detail.body.rawContent).toContain("Evidence Notes");
  });

  it("builds a readable text diff for previews", () => {
    const diff = previewTextDiff("line1\nline2\n", "line1\nline2-changed\n");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+line2-changed");
  });
});
