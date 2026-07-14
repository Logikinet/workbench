import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectStack } from "./detectProjectStack.js";

async function tempWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `paw-verify-${prefix}-`));
}

describe("detectProjectStack", () => {
  it("detects Node.js projects with package scripts and package manager", async () => {
    const root = await tempWorkspace("node");
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "demo",
      scripts: {
        test: "vitest run",
        typecheck: "tsc -p tsconfig.json --noEmit",
        build: "tsc -p tsconfig.json"
      }
    }));
    await writeFile(join(root, "package-lock.json"), "{}");

    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("nodejs");
    expect(stack.kinds).toContain("nodejs");
    expect(stack.packageManager).toBe("npm");
    expect(stack.availableScripts.map((script) => script.name).sort()).toEqual(["build", "test", "typecheck"]);
    expect(stack.hasAutomatedTests).toBe(true);
    expect(stack.clues.some((clue) => clue.path === "package.json")).toBe(true);
  });

  it("detects pnpm and only reports scripts that exist (not a blind triple)", async () => {
    const root = await tempWorkspace("pnpm");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "jest" }
    }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const stack = await detectProjectStack(root);
    expect(stack.packageManager).toBe("pnpm");
    expect(stack.availableScripts.map((script) => script.name)).toEqual(["test"]);
    expect(stack.availableScripts.some((script) => script.name === "typecheck")).toBe(false);
  });

  it("detects Python projects with pytest configuration", async () => {
    const root = await tempWorkspace("py");
    await writeFile(join(root, "pyproject.toml"), `[project]\nname = "demo"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`);
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "test_sample.py"), "def test_ok():\n    assert True\n");

    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("python");
    expect(stack.hasAutomatedTests).toBe(true);
    expect(stack.clues.some((clue) => clue.kind === "python")).toBe(true);
    expect(stack.availableScripts.some((script) => /pytest/i.test(script.name) || /pytest/i.test(script.command ?? ""))).toBe(true);
  });

  it("detects pure HTML projects without inventing Node/Python stacks", async () => {
    const root = await tempWorkspace("html");
    await writeFile(join(root, "index.html"), "<!doctype html><title>Hi</title>");
    await writeFile(join(root, "style.css"), "body{}");

    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("html");
    expect(stack.kinds).toEqual(["html"]);
    expect(stack.hasAutomatedTests).toBe(false);
  });

  it("detects Git metadata as a clue", async () => {
    const root = await tempWorkspace("git");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, "README.md"), "# demo\n");

    const stack = await detectProjectStack(root);
    expect(stack.kinds).toContain("git");
    expect(stack.clues.some((clue) => clue.kind === "git")).toBe(true);
  });

  it("detects HarmonyOS / OpenHarmony markers", async () => {
    const root = await tempWorkspace("harmony");
    await writeFile(join(root, "oh-package.json5"), "{ name: 'app' }\n");
    await writeFile(join(root, "build-profile.json5"), "{}\n");
    await writeFile(join(root, "hvigorfile.ts"), "export default {};\n");

    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("harmonyos");
    expect(stack.clues.filter((clue) => clue.kind === "harmonyos").length).toBeGreaterThanOrEqual(2);
  });

  it("detects Cangjie (仓颉) projects via cjpm.toml and .cj sources", async () => {
    const root = await tempWorkspace("cangjie");
    await writeFile(join(root, "cjpm.toml"), "[package]\nname = \"demo\"\n");
    await writeFile(join(root, "main.cj"), "main() {}\n");

    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("cangjie");
    expect(stack.availableScripts.some((script) => script.name === "cjpm-test")).toBe(true);
  });

  it("returns unknown for empty / missing workspaces without throwing", async () => {
    const root = await tempWorkspace("empty");
    const stack = await detectProjectStack(root);
    expect(stack.primary).toBe("unknown");
    expect(stack.hasAutomatedTests).toBe(false);

    const missing = await detectProjectStack(join(root, "does-not-exist"));
    expect(missing.primary).toBe("unknown");
  });
});
