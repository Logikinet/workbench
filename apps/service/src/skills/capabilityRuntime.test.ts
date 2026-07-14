import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { CapabilityRuntime } from "./capabilityRuntime.js";
import { SkillService } from "./skillService.js";
import type { RoleCapabilityConfig } from "./skillTypes.js";

const basePermissions = {
  workspace: "project_only" as const,
  network: false,
  shell: true,
  externalSend: false
};

function role(overrides: Partial<RoleCapabilityConfig> = {}): RoleCapabilityConfig {
  return {
    id: "role-1",
    name: "实现者",
    harness: "api",
    reasoningEffort: "high",
    skills: ["implement", "tdd"],
    tools: ["filesystem", "shell"],
    permissions: { ...basePermissions },
    systemInstruction: "先读上下文，再做最小修改。",
    enabled: true,
    ...overrides
  };
}

describe("CapabilityRuntime", () => {
  let root: string;
  let skills: SkillService;
  let tools: ToolRegistry;
  let runtime: CapabilityRuntime;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-cap-"));
    skills = await SkillService.createMemory();
    tools = await ToolRegistry.createMemory();
    runtime = new CapabilityRuntime({ skills, tools });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes only Role-enabled and plan-allowed skills/tools", () => {
    const result = runtime.resolve({
      role: role(),
      plan: {
        skills: ["implement"],
        tools: ["filesystem"]
      }
    });

    expect(result.skills.map((skill) => skill.id)).toEqual(["implement"]);
    expect(result.tools.map((tool) => tool.id)).toEqual(["filesystem"]);
    expect(result.blocked.some((entry) => entry.id === "tdd" && entry.reason === "not_on_plan")).toBe(true);
    expect(result.blocked.some((entry) => entry.id === "shell" && entry.reason === "not_on_plan")).toBe(true);
    // Loaded skill instructions are real content
    expect(result.skills[0]?.instructions).toMatch(/Implement/i);
    expect(result.composedInstructions).toContain("先读上下文");
    expect(result.composedInstructions).toContain("Skill: implement");
  });

  it("omits disabled catalog entries even when listed on the Role", async () => {
    await skills.setEnabled("tdd", false);
    await tools.setEnabled("shell", false);

    const result = runtime.resolve({ role: role() });
    expect(result.skills.map((skill) => skill.id)).toEqual(["implement"]);
    expect(result.tools.map((tool) => tool.id)).toEqual(["filesystem"]);
    expect(result.blocked.some((entry) => entry.id === "tdd" && entry.reason === "disabled")).toBe(true);
    expect(result.blocked.some((entry) => entry.id === "shell" && entry.reason === "disabled")).toBe(true);
  });

  it("requires trust before first use of new skills/tools and cannot bypass Role permissions", async () => {
    const skillDir = join(root, "skills");
    await mkdir(join(skillDir, "fresh-skill"), { recursive: true });
    await writeFile(
      join(skillDir, "fresh-skill", "SKILL.md"),
      `---
name: fresh-skill
version: 0.1.0
description: Fresh
---

# Fresh

New method.
`,
      "utf8"
    );
    await skills.addTrustedDirectory(skillDir);
    expect(skills.get("fresh-skill").trusted).toBe(false);

    await tools.register({
      id: "custom-net",
      name: "custom-net",
      description: "Custom network tool",
      category: "network",
      trusted: false
    });

    const untrusted = runtime.resolve({
      role: role({
        skills: ["implement", "fresh-skill"],
        tools: ["filesystem", "custom-net"],
        permissions: { ...basePermissions, network: true }
      })
    });
    expect(untrusted.skills.map((skill) => skill.id)).toEqual(["implement"]);
    expect(untrusted.tools.map((tool) => tool.id)).toEqual(["filesystem"]);
    expect(untrusted.pendingTrust).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill", id: "fresh-skill" }),
        expect.objectContaining({ kind: "tool", id: "custom-net" })
      ])
    );

    // Even after trust, network tool blocked when Role lacks network permission.
    await skills.trust("fresh-skill");
    await tools.trust("custom-net");
    const noNetwork = runtime.resolve({
      role: role({
        skills: ["fresh-skill"],
        tools: ["custom-net"],
        permissions: { ...basePermissions, network: false }
      })
    });
    expect(noNetwork.tools).toEqual([]);
    expect(noNetwork.blocked.some((entry) => entry.reason === "permission_denied")).toBe(true);

    // write tools blocked on read_only workspace
    const readOnly = runtime.resolve({
      role: role({
        tools: ["filesystem"],
        permissions: { workspace: "read_only", network: false, shell: false, externalSend: false }
      })
    });
    expect(readOnly.tools).toEqual([]);
    expect(readOnly.blocked.some((entry) => entry.id === "filesystem" && entry.reason === "permission_denied")).toBe(
      true
    );

    // Plan cannot inject tools not on Role (no bypass of Role boundary).
    const planBypass = runtime.resolve({
      role: role({ tools: ["filesystem"] }),
      plan: { tools: ["filesystem", "shell"] }
    });
    expect(planBypass.tools.map((tool) => tool.id)).toEqual(["filesystem"]);
    expect(planBypass.blocked.some((entry) => entry.id === "shell" && entry.reason === "not_on_role")).toBe(true);
  });

  it("applies reasoningEffort when supported and surfaces unsupported harness config explicitly", () => {
    const applied = runtime.resolve({ role: role({ harness: "api", reasoningEffort: "high" }) });
    expect(applied.harnessConfig.reasoningEffort).toMatchObject({
      requested: "high",
      supported: true,
      applied: "high",
      status: "applied"
    });
    expect(applied.snapshot.harnessConfig.reasoningEffort.applied).toBe("high");

    const unsupported = runtime.resolve({
      role: role({ harness: "api" }),
      harnessSupportsReasoning: false,
      extraHarnessConfig: { temperature: 0.2 }
    });
    expect(unsupported.harnessConfig.reasoningEffort.status).toBe("unsupported");
    expect(unsupported.harnessConfig.reasoningEffort.applied).toBeUndefined();
    expect(unsupported.harnessConfig.reasoningEffort.message).toMatch(/not applied/i);
    expect(unsupported.harnessConfig.unsupportedRequested).toEqual([
      expect.objectContaining({ key: "temperature", message: expect.stringMatching(/not supported/i) })
    ]);
  });

  it("records a timeline capability snapshot with versions and permission snapshot", () => {
    const result = runtime.resolve({ role: role() });
    const snapshot = result.snapshot;
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.roleId).toBe("role-1");
    expect(snapshot.permissions).toEqual(basePermissions);
    expect(snapshot.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implement", version: expect.any(String), trusted: true }),
        expect.objectContaining({ id: "tdd", version: expect.any(String) })
      ])
    );
    expect(snapshot.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "filesystem",
          category: "write",
          version: expect.any(String)
        }),
        expect.objectContaining({
          id: "shell",
          category: "shell",
          requiresApproval: true
        })
      ])
    );
    expect(snapshot.harnessConfig.reasoningEffort.applied).toBe("high");
  });

  it("migrates name-only Role configs without breaking historical name references", () => {
    const migrated = runtime.migrateRoleNames({
      skills: ["implement", "tdd", "legacy-unknown"],
      tools: ["filesystem", "shell", "missing-tool"]
    });
    expect(migrated.skills).toEqual(["implement", "tdd"]);
    expect(migrated.tools).toEqual(["filesystem", "shell"]);
    expect(migrated.unknownSkills).toEqual(["legacy-unknown"]);
    expect(migrated.unknownTools).toEqual(["missing-tool"]);
    expect(migrated.complete).toBe(false);

    // Complete migration for typical legacy Role
    const complete = runtime.migrateRoleNames({
      skills: ["implement", "code-review", "research", "documents", "skill-creator"],
      tools: ["filesystem", "shell", "web", "git", "model-api", "codex-cli"]
    });
    expect(complete.complete).toBe(true);
    expect(complete.unknownSkills).toEqual([]);
    expect(complete.unknownTools).toEqual([]);

    // Resolve still works with name-only Role (historical runs remain readable via snapshot shape)
    const resolved = runtime.resolve({
      role: role({
        skills: ["implement"],
        tools: ["filesystem", "shell"]
      })
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.snapshot.skills[0]).toMatchObject({ id: "implement", name: "implement" });
  });

  it("returns no capabilities when Role is disabled", () => {
    const result = runtime.resolve({ role: role({ enabled: false }) });
    expect(result.ok).toBe(false);
    expect(result.skills).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.blocked[0]?.reason).toBe("role_disabled");
  });

  it("marks dangerous tools as requiring approval when exposed", async () => {
    await tools.setEnabled("dangerous_exec", true);
    await tools.trust("dangerous_exec");
    const result = runtime.resolve({
      role: role({
        tools: ["dangerous_exec"],
        permissions: { ...basePermissions, shell: true }
      })
    });
    expect(result.tools).toEqual([
      expect.objectContaining({ id: "dangerous_exec", category: "dangerous", requiresApproval: true })
    ]);
  });
});
