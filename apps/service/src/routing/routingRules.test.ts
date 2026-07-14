import { describe, expect, it } from "vitest";
import type { AgentRole } from "../roles/roleService.js";
import {
  evaluateRoutingRules,
  manualOverrideRejects,
  normalizeRoutingRule,
  sortRules,
  type RoutingRule
} from "./routingRules.js";

function role(partial: Partial<AgentRole> & Pick<AgentRole, "id" | "name">): AgentRole {
  return {
    responsibility: "r",
    systemInstruction: "s",
    harness: "api",
    reasoningEffort: "medium",
    skills: ["implement", "tdd"],
    tools: ["filesystem", "shell"],
    permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
    allowFirstmateAutoInvoke: true,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...partial
  };
}

describe("routingRules (Task 38 ordered first-match)", () => {
  it("sorts by order then id for stable evaluation", () => {
    const rules = [
      normalizeRoutingRule({ name: "b", order: 20, roleId: "r1" }, "b"),
      normalizeRoutingRule({ name: "a", order: 10, roleId: "r1" }, "a"),
      normalizeRoutingRule({ name: "c", order: 10, roleId: "r1" }, "c")
    ];
    expect(sortRules(rules).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("selects the first valid matching rule and records later skips", () => {
    const roles = [
      role({ id: "research", name: "调研", skills: ["research"], tools: ["filesystem", "web"], permissions: { workspace: "read_only", network: true, shell: false, externalSend: false } }),
      role({ id: "impl", name: "实现", skills: ["implement", "tdd"], tools: ["filesystem", "shell"] })
    ];
    const rules: RoutingRule[] = [
      normalizeRoutingRule(
        {
          name: "research-first",
          order: 10,
          roleId: "research",
          match: { taskTypes: ["research"], requiredCapabilities: ["research"] }
        },
        "rule-research"
      ),
      normalizeRoutingRule(
        {
          name: "impl-second",
          order: 20,
          roleId: "impl",
          match: { taskTypes: ["implementation"], requiredCapabilities: ["filesystem"] }
        },
        "rule-impl"
      )
    ];

    const hit = evaluateRoutingRules(
      rules,
      { taskType: "research", requiredCapabilities: ["research", "documents"] },
      roles
    );
    expect(hit.fallbackCode).toBe("rule_selected");
    expect(hit.matchedRule?.id).toBe("rule-research");
    expect(hit.matchedRole?.id).toBe("research");
    expect(hit.evaluations.find((e) => e.ruleId === "rule-research")?.selected).toBe(true);
    expect(hit.evaluations.find((e) => e.ruleId === "rule-impl")?.selected).toBe(false);
    expect(hit.evaluations.find((e) => e.ruleId === "rule-impl")?.matchRejectReasons.join(" ")).toMatch(
      /更高优先级|跳过/
    );
  });

  it("continues to the next rule when the first match has an invalid role", () => {
    const roles = [
      role({ id: "disabled", name: "停用", enabled: false }),
      role({ id: "ok", name: "可用" })
    ];
    const rules: RoutingRule[] = [
      normalizeRoutingRule(
        { name: "bad", order: 1, roleId: "disabled", match: { projectIds: ["p1"] }, onInvalid: "continue" },
        "r1"
      ),
      normalizeRoutingRule(
        { name: "good", order: 2, roleId: "ok", match: { projectIds: ["p1"] } },
        "r2"
      )
    ];

    const result = evaluateRoutingRules(rules, { projectId: "p1" }, roles);
    expect(result.matchedRole?.id).toBe("ok");
    expect(result.evaluations[0]?.roleEligible).toBe(false);
    expect(result.evaluations[0]?.roleRejectReasons.join(" ")).toMatch(/停用/);
    expect(result.evaluations[1]?.selected).toBe(true);
  });

  it("pauses when onInvalid=pause instead of falling through", () => {
    const roles = [role({ id: "disabled", name: "停用", enabled: false }), role({ id: "ok", name: "可用" })];
    const rules: RoutingRule[] = [
      normalizeRoutingRule(
        {
          name: "must-this",
          order: 1,
          roleId: "disabled",
          match: { taskTypes: ["implementation"] },
          onInvalid: "pause"
        },
        "pause-rule"
      ),
      normalizeRoutingRule(
        { name: "should-not", order: 2, roleId: "ok", match: { taskTypes: ["implementation"] } },
        "later"
      )
    ];

    const result = evaluateRoutingRules(rules, { taskType: "implementation" }, roles);
    expect(result.fallbackCode).toBe("paused_on_invalid");
    expect(result.matchedRule).toBeUndefined();
    expect(result.paused?.ruleId).toBe("pause-rule");
    expect(result.evaluations.find((e) => e.ruleId === "later")?.matchRejectReasons.join(" ")).toMatch(/暂停/);
  });

  it("explains fallback when nothing matches", () => {
    const rules: RoutingRule[] = [
      normalizeRoutingRule(
        {
          name: "only-codex",
          order: 1,
          roleId: "x",
          match: { harness: "codex-cli", taskTypes: ["automation"] }
        },
        "only"
      )
    ];
    const result = evaluateRoutingRules(
      rules,
      { taskType: "research", preferredHarness: "api" },
      [role({ id: "x", name: "x", harness: "codex-cli" })]
    );
    expect(result.fallbackCode).toBe("none_matched");
    expect(result.fallbackReason).toMatch(/fallback|自动/i);
  });

  it("manualOverrideRejects permission violations without auto-replacing", () => {
    const weak = role({
      id: "weak",
      name: "弱权限",
      permissions: { workspace: "read_only", network: false, shell: false, externalSend: false },
      skills: ["research"],
      tools: ["filesystem"]
    });
    const rejects = manualOverrideRejects(weak, {
      requiredPermissions: { shell: true, workspace: "project_only" },
      requiredSkills: ["implement"]
    });
    expect(rejects.join(" ")).toMatch(/shell/);
    expect(rejects.join(" ")).toMatch(/Skills|implement/i);
  });
});
