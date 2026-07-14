import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { CapabilityRuntime } from "./capabilityRuntime.js";
import { createSkillRouteApp } from "./skillRoutes.js";
import { SkillService } from "./skillService.js";

describe("skill + capability routes", () => {
  let root: string;
  let skills: SkillService;
  let tools: ToolRegistry;
  let runtime: CapabilityRuntime;
  let app: Awaited<ReturnType<typeof createSkillRouteApp>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-skill-routes-"));
    skills = await SkillService.createMemory();
    tools = await ToolRegistry.createMemory();
    runtime = new CapabilityRuntime({ skills, tools });
    app = await createSkillRouteApp({ skills, capabilityRuntime: runtime });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists skills, imports from trusted dir, enables/disables, trusts, and returns content", async () => {
    const listed = await request(app).get("/api/skills").expect(200);
    expect(listed.body.skills.some((skill: { id: string }) => skill.id === "implement")).toBe(true);

    const skillDir = join(root, "pack");
    await mkdir(join(skillDir, "route-skill"), { recursive: true });
    await writeFile(
      join(skillDir, "route-skill", "SKILL.md"),
      `---
name: route-skill
version: 1.0.1
description: Via HTTP
---

# Route Skill

Follow the route.
`,
      "utf8"
    );

    await request(app)
      .post("/api/skills/import")
      .send({ directory: skillDir })
      .expect(400);

    await request(app)
      .post("/api/skills/import")
      .send({ directory: skillDir, trustDirectory: true })
      .expect(201);

    const detail = await request(app).get("/api/skills/route-skill").expect(200);
    expect(detail.body).toMatchObject({ id: "route-skill", version: "1.0.1", trusted: false });

    const content = await request(app).get("/api/skills/route-skill/content").expect(200);
    expect(content.body.instructions).toContain("Follow the route");
    expect(content.body.raw).toContain("name: route-skill");

    await request(app).post("/api/skills/route-skill/trust").expect(200);
    await request(app).post("/api/skills/route-skill/disable").expect(200);
    expect((await skills.get("route-skill")).enabled).toBe(false);
    await request(app).post("/api/skills/route-skill/enable").expect(200);
    expect((await skills.get("route-skill")).enabled).toBe(true);
  });

  it("resolves capabilities and migrates name-only role configs", async () => {
    const resolved = await request(app)
      .post("/api/capabilities/resolve")
      .send({
        role: {
          id: "r1",
          name: "实现者",
          harness: "api",
          reasoningEffort: "medium",
          skills: ["implement", "tdd"],
          tools: ["filesystem", "shell"],
          permissions: {
            workspace: "project_only",
            network: false,
            shell: true,
            externalSend: false
          },
          systemInstruction: "最小修改"
        },
        plan: {
          skills: ["implement"],
          tools: ["filesystem"]
        }
      })
      .expect(200);

    expect(resolved.body.skills.map((skill: { id: string }) => skill.id)).toEqual(["implement"]);
    expect(resolved.body.tools.map((tool: { id: string }) => tool.id)).toEqual(["filesystem"]);
    expect(resolved.body.snapshot.permissions.shell).toBe(true);
    expect(resolved.body.harnessConfig.reasoningEffort.applied).toBe("medium");
    expect(resolved.body.composedInstructions).toContain("最小修改");

    const migrated = await request(app)
      .post("/api/capabilities/migrate-role")
      .send({
        skills: ["implement", "ghost"],
        tools: ["filesystem"]
      })
      .expect(200);
    expect(migrated.body).toMatchObject({
      skills: ["implement"],
      tools: ["filesystem"],
      unknownSkills: ["ghost"],
      complete: false
    });
  });
});
