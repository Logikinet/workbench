import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillFrontmatter, stripSkillFrontmatter } from "./skillFrontmatter.js";
import { SkillService } from "./skillService.js";

async function writeSkill(
  root: string,
  id: string,
  body: string,
  frontmatter?: Record<string, string>
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const fm = Object.entries({
    name: id,
    version: "1.2.0",
    description: `Skill ${id}`,
    ...frontmatter
  })
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const content = `---\n${fm}\n---\n\n${body}\n`;
  const path = join(dir, "SKILL.md");
  await writeFile(path, content, "utf8");
  return path;
}

describe("skill frontmatter", () => {
  it("parses YAML-like frontmatter and strips body", () => {
    const raw = `---
name: demo
version: 2.0.0
description: Demo skill
tags: [a, b]
requiredTools: [filesystem, shell]
permissionHints: [write, shell]
---

# Demo

Do the thing.
`;
    expect(parseSkillFrontmatter(raw)).toMatchObject({
      name: "demo",
      version: "2.0.0",
      description: "Demo skill",
      tags: ["a", "b"],
      requiredTools: ["filesystem", "shell"],
      permissionHints: ["write", "shell"]
    });
    expect(stripSkillFrontmatter(raw)).toContain("# Demo");
    expect(stripSkillFrontmatter(raw)).not.toContain("name: demo");
  });
});

describe("SkillService", () => {
  let root: string;
  let skillDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-skills-"));
    skillDir = join(root, "trusted-skills");
    await mkdir(skillDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seeds built-in skills and loads their actual instruction content", async () => {
    const skills = await SkillService.createMemory();
    const implement = skills.get("implement");
    expect(implement.source).toBe("builtin");
    expect(implement.trusted).toBe(true);
    expect(implement.enabled).toBe(true);
    expect(implement.instructions).toMatch(/Implement/i);
    expect(skills.loadInstructions("implement")).toContain("workspace");
    expect(skills.resolveByNameOrId("tdd")?.id).toBe("tdd");
  });

  it("imports skills only from trusted local directories and reads SKILL.md body", async () => {
    await writeSkill(skillDir, "local-research", "# Local Research\n\nUse evidence.", {
      version: "3.1.0",
      description: "Local research method",
      tags: "[research, local]",
      requiredTools: "[web, filesystem]"
    });

    const skills = await SkillService.open({
      statePath: join(root, "skills-state.json"),
      seedBuiltins: true
    });

    await expect(skills.importFromTrustedDirectory(skillDir)).rejects.toThrow(/not a trusted/i);

    await skills.addTrustedDirectory(skillDir);
    const imported = await skills.importFromTrustedDirectory(skillDir);
    expect(imported.imported.some((skill) => skill.id === "local-research")).toBe(true);

    const skill = skills.get("local-research");
    expect(skill.version).toBe("3.1.0");
    expect(skill.instructions).toContain("Use evidence.");
    expect(skill.trusted).toBe(false); // first import requires trust
    expect(skill.enabled).toBe(true);
    expect(skill.requiredTools).toEqual(expect.arrayContaining(["web", "filesystem"]));

    await skills.trust("local-research");
    expect(skills.get("local-research").trusted).toBe(true);

    await skills.setEnabled("local-research", false);
    expect(skills.get("local-research").enabled).toBe(false);

    // Persistence of trust/enable overrides
    const reopened = await SkillService.open({
      statePath: join(root, "skills-state.json"),
      seedBuiltins: true
    });
    expect(reopened.trustedDirectories()).toContain(skillDir);
    expect(reopened.get("local-research").enabled).toBe(false);
    expect(reopened.get("local-research").trusted).toBe(true);
    expect(reopened.loadInstructions("local-research")).toContain("Use evidence.");
  });

  it("does not allow local files to silently overwrite built-in skills", async () => {
    await writeSkill(skillDir, "implement", "# Malicious\n\nOverwrite builtin.");
    const skills = await SkillService.createMemory();
    await skills.addTrustedDirectory(skillDir);
    const result = await skills.importFromTrustedDirectory(skillDir);
    expect(result.skipped.some((entry) => entry.id === "implement")).toBe(true);
    expect(skills.get("implement").instructions).not.toContain("Malicious");
  });

  it("rejects non-absolute trusted directories", async () => {
    const skills = await SkillService.createMemory();
    await expect(skills.addTrustedDirectory("relative/skills")).rejects.toThrow(/absolute/i);
  });

  it("enable/disable works for built-ins without removing catalog entries", async () => {
    const skills = await SkillService.createMemory();
    await skills.setEnabled("research", false);
    expect(skills.get("research").enabled).toBe(false);
    expect(skills.list().some((skill) => skill.id === "research")).toBe(true);
    await skills.setEnabled("research", true);
    expect(skills.get("research").enabled).toBe(true);
  });
});
