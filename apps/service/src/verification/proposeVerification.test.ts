import { describe, expect, it } from "vitest";
import type { DetectedProjectStack } from "./types.js";
import {
  applyUserVerificationEdits,
  bindVerificationPlanToApprovedVersion,
  defaultVerificationCommandsForTaskType,
  enabledVerificationCommands,
  proposeVerificationPlan
} from "./proposeVerification.js";
import { sameCommand } from "./commandMatch.js";

function stack(partial: Partial<DetectedProjectStack> & Pick<DetectedProjectStack, "primary">): DetectedProjectStack {
  return {
    kinds: partial.kinds ?? [partial.primary],
    clues: partial.clues ?? [],
    availableScripts: partial.availableScripts ?? [],
    packageManager: partial.packageManager,
    hasAutomatedTests: partial.hasAutomatedTests ?? false,
    workspacePath: partial.workspacePath ?? "/tmp/ws",
    primary: partial.primary
  };
}

describe("proposeVerificationPlan", () => {
  it("proposes only evidenced Node scripts — not a blind npm test/typecheck/build triple", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "npm",
        hasAutomatedTests: true,
        availableScripts: [
          { name: "test", command: "vitest run", source: "package.json" }
        ],
        clues: [{ kind: "nodejs", path: "package.json", detail: "package.json", confidence: "high" }]
      }),
      taskType: "implementation"
    });

    const enabled = enabledVerificationCommands(plan);
    expect(enabled).toEqual([["npm", "test"]]);
    expect(enabled.some((command) => sameCommand(command, ["npm", "run", "typecheck"]))).toBe(false);
    expect(enabled.some((command) => sameCommand(command, ["npm", "run", "build"]))).toBe(false);
    expect(plan.commands.every((entry) => entry.source === "project_evidence")).toBe(true);
  });

  it("uses pnpm when lockfile evidence says so", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "pnpm",
        hasAutomatedTests: true,
        availableScripts: [
          { name: "test", command: "jest", source: "package.json" },
          { name: "typecheck", command: "tsc", source: "package.json" }
        ]
      }),
      taskType: "bug_fix"
    });
    expect(enabledVerificationCommands(plan)).toEqual([
      ["pnpm", "test"],
      ["pnpm", "run", "typecheck"]
    ]);
  });

  it("proposes pytest for Python evidence", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "python",
        hasAutomatedTests: true,
        availableScripts: [{ name: "pytest", command: "pytest", source: "pyproject.toml" }],
        clues: [{ kind: "python", path: "pyproject.toml", detail: "pytest", confidence: "high" }]
      }),
      taskType: "implementation"
    });
    expect(enabledVerificationCommands(plan)).toEqual([["pytest"]]);
    expect(plan.commands[0]?.source).toBe("project_evidence");
  });

  it("generates a manual checklist for pure HTML instead of npm commands", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "html",
        hasAutomatedTests: false,
        clues: [{ kind: "html", path: "index.html", detail: "index.html", confidence: "medium" }]
      }),
      taskType: "implementation"
    });
    expect(enabledVerificationCommands(plan)).toEqual([]);
    expect(plan.manualChecklist.length).toBeGreaterThan(0);
    expect(plan.manualChecklist.some((item) => /index\.html|浏览器/i.test(item.description))).toBe(true);
    expect(plan.commands.some((entry) => entry.command[0] === "npm")).toBe(false);
  });

  it("generates manual checklist when no automated tests exist", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "unknown",
        hasAutomatedTests: false
      }),
      taskType: "implementation"
    });
    expect(enabledVerificationCommands(plan)).toEqual([]);
    expect(plan.manualChecklist.length).toBeGreaterThan(0);
    expect(plan.assumptions.some((line) => /手工|不强制|未检测/.test(line))).toBe(true);
  });

  it("prefers user-specified commands and records source", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "npm",
        hasAutomatedTests: true,
        availableScripts: [{ name: "test", command: "vitest", source: "package.json" }]
      }),
      taskType: "implementation",
      userCommands: [["npm", "run", "test:unit"]]
    });
    expect(plan.commands.some((entry) => entry.source === "user_specified" && sameCommand(entry.command, ["npm", "run", "test:unit"]))).toBe(true);
  });

  it("allows disabling commands before approval", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "npm",
        hasAutomatedTests: true,
        availableScripts: [
          { name: "test", command: "vitest", source: "package.json" },
          { name: "build", command: "tsc", source: "package.json" }
        ]
      }),
      taskType: "implementation",
      disabledCommands: [["npm", "run", "build"]]
    });
    const build = plan.commands.find((entry) => sameCommand(entry.command, ["npm", "run", "build"]));
    // build may or may not be proposed depending on heuristics; disabled list must mark it if present
    if (build) expect(build.enabled).toBe(false);
    expect(enabledVerificationCommands(plan).every((command) => !sameCommand(command, ["npm", "run", "build"]))).toBe(true);
  });

  it("does not force automation for research — checklist instead", () => {
    const plan = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "npm",
        hasAutomatedTests: true,
        availableScripts: [{ name: "test", command: "vitest", source: "package.json" }]
      }),
      taskType: "research"
    });
    // research skips evidence automation path
    expect(enabledVerificationCommands(plan)).toEqual([]);
    expect(plan.manualChecklist.some((item) => /证据|结论/.test(item.description))).toBe(true);
  });

  it("proposes HarmonyOS and Cangjie hypotheses/evidence distinctly from npm", () => {
    const harmony = proposeVerificationPlan({
      stack: stack({
        primary: "harmonyos",
        hasAutomatedTests: false,
        clues: [{ kind: "harmonyos", path: "oh-package.json5", detail: "HarmonyOS", confidence: "high" }]
      }),
      taskType: "implementation"
    });
    expect(enabledVerificationCommands(harmony)[0]?.[0]).toBe("hvigorw");
    expect(enabledVerificationCommands(harmony).flat().includes("npm")).toBe(false);

    const cangjie = proposeVerificationPlan({
      stack: stack({
        primary: "cangjie",
        hasAutomatedTests: true,
        availableScripts: [{ name: "cjpm-test", command: "cjpm test", source: "cjpm.toml" }],
        clues: [{ kind: "cangjie", path: "cjpm.toml", detail: "cjpm", confidence: "high" }]
      }),
      taskType: "implementation"
    });
    expect(enabledVerificationCommands(cangjie)).toEqual([["cjpm", "test"]]);
  });

  it("proves sample projects never all collapse to npm test/typecheck/build", () => {
    const samples = [
      proposeVerificationPlan({
        stack: stack({
          primary: "python",
          hasAutomatedTests: true,
          availableScripts: [{ name: "pytest", command: "pytest", source: "pytest.ini" }],
          clues: [{ kind: "python", path: "pytest.ini", detail: "pytest", confidence: "high" }]
        }),
        taskType: "implementation"
      }),
      proposeVerificationPlan({
        stack: stack({ primary: "html", hasAutomatedTests: false }),
        taskType: "implementation"
      }),
      proposeVerificationPlan({
        stack: stack({
          primary: "cangjie",
          hasAutomatedTests: true,
          clues: [{ kind: "cangjie", path: "cjpm.toml", detail: "cjpm", confidence: "high" }],
          availableScripts: [{ name: "cjpm-test", command: "cjpm test", source: "cjpm.toml" }]
        }),
        taskType: "bug_fix"
      }),
      proposeVerificationPlan({
        stack: stack({
          primary: "nodejs",
          packageManager: "npm",
          hasAutomatedTests: true,
          availableScripts: [{ name: "test", command: "vitest", source: "package.json" }]
        }),
        taskType: "implementation"
      })
    ];

    const classic = (commands: string[][]) =>
      commands.length === 3
      && sameCommand(commands[0]!, ["npm", "test"])
      && sameCommand(commands[1]!, ["npm", "run", "typecheck"])
      && sameCommand(commands[2]!, ["npm", "run", "build"]);

    const signatures = samples.map((plan) => enabledVerificationCommands(plan).map((command) => command.join(" ")).join(" | "));
    expect(new Set(signatures).size).toBeGreaterThan(1);
    for (const plan of samples) {
      expect(classic(enabledVerificationCommands(plan))).toBe(false);
    }
  });
});

describe("user edits and approval binding", () => {
  it("lets users modify, disable, and supplement commands before approval", () => {
    const draft = proposeVerificationPlan({
      stack: stack({
        primary: "nodejs",
        packageManager: "npm",
        hasAutomatedTests: true,
        availableScripts: [{ name: "test", command: "vitest", source: "package.json" }]
      }),
      taskType: "implementation"
    });

    const edited = applyUserVerificationEdits({
      plan: draft,
      commands: [
        { command: ["npm", "test"], enabled: false },
        { command: ["npm", "run", "test:unit"], enabled: true, rationale: "用户补充单测" }
      ],
      manualChecklist: [{ description: "人工确认 UI 截图" }]
    });

    expect(edited.status).toBe("draft");
    expect(enabledVerificationCommands(edited)).toEqual([["npm", "run", "test:unit"]]);
    expect(edited.manualChecklist[0]?.description).toMatch(/UI/);
  });

  it("binds commands to an approved plan version", () => {
    const draft = proposeVerificationPlan({
      stack: stack({
        primary: "python",
        hasAutomatedTests: true,
        availableScripts: [{ name: "pytest", command: "pytest", source: "pyproject.toml" }],
        clues: [{ kind: "python", path: "pyproject.toml", detail: "pytest", confidence: "high" }]
      }),
      taskType: "implementation"
    });
    const approved = bindVerificationPlanToApprovedVersion(draft, 2);
    expect(approved.status).toBe("approved");
    expect(approved.approvedPlanVersion).toBe(2);
    expect(enabledVerificationCommands(approved)).toEqual([["pytest"]]);
  });

  it("task-type-only default is empty (no blind npm)", () => {
    expect(defaultVerificationCommandsForTaskType("implementation")).toEqual([]);
    expect(defaultVerificationCommandsForTaskType("bug_fix")).toEqual([]);
    expect(defaultVerificationCommandsForTaskType("research")).toEqual([]);
  });
});
