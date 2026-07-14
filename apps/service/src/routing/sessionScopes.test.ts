import { describe, expect, it } from "vitest";
import {
  allowsPrivateMemory,
  assertNoCrossLeak,
  assertScopeValid,
  buildSessionKey,
  canShareContext,
  createSessionLocalConfig,
  filterContextForScope,
  parseSessionKey,
  resolveSessionModelId,
  type SessionScopeRef
} from "./sessionScopes.js";

describe("sessionScopes (Task 38 isolation)", () => {
  it("builds and parses stable keys for all five scopes", () => {
    const scopes: SessionScopeRef[] = [
      { kind: "global_firstmate" },
      { kind: "project_firstmate", projectId: "Proj-A" },
      { kind: "run", runId: "run-1", projectId: "p1" },
      { kind: "subtask", runId: "run-1", subtaskId: "st-9", projectId: "p1" },
      { kind: "reviewer", runId: "run-1", projectId: "p1", clientProfileId: "client-x" }
    ];

    for (const scope of scopes) {
      const key = buildSessionKey(scope);
      expect(key.startsWith("scope:")).toBe(true);
      const parsed = parseSessionKey(key);
      expect(parsed?.kind).toBe(scope.kind);
      if (scope.projectId) expect(parsed?.projectId).toBe(scope.projectId.toLowerCase());
      if (scope.runId) expect(parsed?.runId).toBe(scope.runId.toLowerCase());
      if (scope.subtaskId) expect(parsed?.subtaskId).toBe(scope.subtaskId.toLowerCase());
      if (scope.clientProfileId) expect(parsed?.clientProfileId).toBe(scope.clientProfileId.toLowerCase());
    }
  });

  it("rejects incomplete scopes", () => {
    expect(() => assertScopeValid({ kind: "project_firstmate" })).toThrow(/projectId/);
    expect(() => assertScopeValid({ kind: "run" })).toThrow(/runId/);
    expect(() => assertScopeValid({ kind: "subtask", runId: "r1" })).toThrow(/subtaskId/);
    expect(() => assertScopeValid({ kind: "reviewer" })).toThrow(/runId/);
  });

  it("blocks cross-project context leak", () => {
    const a: SessionScopeRef = { kind: "project_firstmate", projectId: "alpha" };
    const b: SessionScopeRef = { kind: "project_firstmate", projectId: "beta" };
    const decision = canShareContext(a, b);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Project/);
    expect(() => assertNoCrossLeak(a, b)).toThrow(/Project/);
  });

  it("blocks cross-client profile leak", () => {
    const a: SessionScopeRef = {
      kind: "run",
      runId: "r1",
      projectId: "p1",
      clientProfileId: "cust-a"
    };
    const b: SessionScopeRef = {
      kind: "run",
      runId: "r1",
      projectId: "p1",
      clientProfileId: "cust-b"
    };
    expect(canShareContext(a, b).allowed).toBe(false);
    expect(canShareContext(a, b).reason).toMatch(/客户|client/i);
  });

  it("isolates sibling subtasks and different runs", () => {
    const s1: SessionScopeRef = { kind: "subtask", runId: "r1", subtaskId: "a", projectId: "p" };
    const s2: SessionScopeRef = { kind: "subtask", runId: "r1", subtaskId: "b", projectId: "p" };
    expect(canShareContext(s1, s2).allowed).toBe(false);

    const r1: SessionScopeRef = { kind: "run", runId: "r1", projectId: "p" };
    const r2: SessionScopeRef = { kind: "run", runId: "r2", projectId: "p" };
    expect(canShareContext(r1, r2).allowed).toBe(false);
  });

  it("keeps reviewer free of private implementer memory", () => {
    const run: SessionScopeRef = { kind: "run", runId: "r1", projectId: "p1" };
    const reviewer: SessionScopeRef = { kind: "reviewer", runId: "r1", projectId: "p1" };

    expect(allowsPrivateMemory(reviewer)).toBe(false);
    expect(allowsPrivateMemory(run)).toBe(true);

    const share = canShareContext(run, reviewer);
    expect(share.allowed).toBe(true);
    expect(share.allowedLayers).not.toContain("role_experience");
    expect(share.allowedLayers).toEqual(expect.arrayContaining(["project_facts", "task_checkpoints"]));

    const filtered = filterContextForScope(reviewer, {
      project_facts: ["fact"],
      task_checkpoints: ["cp"],
      role_experience: ["secret-method"],
      privateMemory: "MEMORY.md body",
      sharedEvidence: ["e1"]
    });
    expect(filtered.project_facts).toEqual(["fact"]);
    expect(filtered.task_checkpoints).toEqual(["cp"]);
    expect(filtered.sharedEvidence).toEqual(["e1"]);
    expect(filtered.role_experience).toBeUndefined();
    expect(filtered.privateMemory).toBeUndefined();
  });

  it("session-local tags/model/instructions never imply Role mutation", () => {
    const local = createSessionLocalConfig({
      tags: ["alpha", "alpha", " beta "],
      preferredModelId: "gpt-session",
      temporaryInstructions: "  only this session  ",
      agentRoleId: "role-1"
    });
    expect(local.tags).toEqual(["alpha", "beta"]);
    expect(local.preferredModelId).toBe("gpt-session");
    expect(local.temporaryInstructions).toBe("only this session");
    // Prefer session model over role model without writing Role.
    expect(resolveSessionModelId("gpt-role", local)).toBe("gpt-session");
    expect(resolveSessionModelId("gpt-role", createSessionLocalConfig())).toBe("gpt-role");
  });
});
