import { describe, expect, it } from "vitest";
import { assertOnlyApprovedCommands, checkApprovedExecution } from "./approvedExecution.js";
import type { VerificationPlan } from "./types.js";

const approvedPlan = {
  status: "approved",
  approvedPlanVersion: 1,
  assumptions: [],
  manualChecklist: [],
  stack: {
    primary: "nodejs",
    kinds: ["nodejs"],
    clues: [],
    availableScripts: [],
    hasAutomatedTests: true,
    workspacePath: "/ws"
  },
  commands: [
    { command: ["npm", "test"], enabled: true, source: "project_evidence", rationale: "test" },
    { command: ["npm", "run", "build"], enabled: false, source: "project_evidence", rationale: "disabled" }
  ]
} satisfies VerificationPlan;

describe("approved execution gate", () => {
  it("allows only approved enabled commands", () => {
    const result = checkApprovedExecution([["npm", "test"]], approvedPlan);
    expect(result.ok).toBe(true);
    expect(result.allowed).toEqual([["npm", "test"]]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects new commands that need re-approval", () => {
    const result = checkApprovedExecution(
      [["npm", "test"], ["npm", "run", "lint"]],
      [["npm", "test"]]
    );
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual([["npm", "run", "lint"]]);
    expect(result.reason).toMatch(/approved|批准|重新/i);
  });

  it("rejects disabled plan commands even if listed historically", () => {
    const result = checkApprovedExecution([["npm", "run", "build"]], approvedPlan);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual([["npm", "run", "build"]]);
  });

  it("assertOnlyApprovedCommands throws on unapproved argv", () => {
    expect(() => assertOnlyApprovedCommands([["pytest"]], [["npm", "test"]])).toThrow(/approved|批准/i);
    expect(assertOnlyApprovedCommands([["npm", "test"]], [["npm", "test"]])).toEqual([["npm", "test"]]);
  });

  it("blocks execution when the approved plan has no commands", () => {
    const result = checkApprovedExecution([["npm", "test"]], []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/未绑定|重新审批|approved/i);
  });
});
