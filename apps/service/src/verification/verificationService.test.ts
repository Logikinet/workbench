import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVerificationService } from "./verificationService.js";
import { enabledVerificationCommands } from "./proposeVerification.js";

describe("VerificationService", () => {
  it("detects workspace and proposes project-aware commands end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "paw-vs-"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", lint: "eslint ." }
    }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const service = createVerificationService();
    const plan = await service.proposeFromWorkspace({
      workspacePath: root,
      taskType: "implementation"
    });

    expect(plan.stack.primary).toBe("nodejs");
    expect(plan.stack.packageManager).toBe("pnpm");
    expect(enabledVerificationCommands(plan)).toEqual([
      ["pnpm", "test"],
      ["pnpm", "run", "lint"]
    ]);
    expect(enabledVerificationCommands(plan).flat().includes("npm")).toBe(false);

    const bound = service.bindToApprovedPlan(plan, 1);
    expect(bound.status).toBe("approved");
    expect(service.assertExecution([["pnpm", "test"]], bound)).toEqual([["pnpm", "test"]]);
    expect(() => service.assertExecution([["npm", "test"]], bound)).toThrow();

    const evidence = service.buildEvidence({
      results: [{ command: ["pnpm", "test"], exitCode: 0, stdout: "ok", stderr: "" }],
      stackPrimary: plan.stack.primary,
      plan: bound
    });
    expect(evidence.kind).toBe("project-verification");
    expect(evidence.allPassed).toBe(true);
    expect(evidence.results[0]?.passed).toBe(true);
  });

  it("uses manual checklist for HTML sample workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "paw-html-"));
    await writeFile(join(root, "index.html"), "<!doctype html><h1>Hi</h1>");

    const service = createVerificationService();
    const plan = await service.proposeFromWorkspace({ workspacePath: root, taskType: "implementation" });
    expect(plan.stack.primary).toBe("html");
    expect(enabledVerificationCommands(plan)).toEqual([]);
    expect(plan.manualChecklist.length).toBeGreaterThan(0);
  });

  it("supports Python sample without npm fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "paw-py-"));
    await writeFile(join(root, "requirements.txt"), "pytest\n");
    await writeFile(join(root, "pytest.ini"), "[pytest]\n");
    await mkdir(join(root, "tests"));

    const service = createVerificationService();
    const plan = await service.proposeFromWorkspace({ workspacePath: root, taskType: "bug_fix" });
    expect(plan.stack.primary).toBe("python");
    expect(enabledVerificationCommands(plan)[0]?.[0]).toBe("pytest");
  });
});
