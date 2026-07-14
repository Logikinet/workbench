import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlledTools, resolveWorkspacePath } from "./controlledTools.js";
import type { ToolContext } from "./toolLoop.js";

describe("controlledTools", () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-controlled-tools-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "readme.md"), "# Hello TODO search\n", "utf8");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "main.ts"), "export const x = 1;\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return {
      runId: "run-1",
      workspacePath: workspace,
      signal: new AbortController().signal,
      maxOutputBytes: 16_000
    };
  }

  function tools(overrides: Parameters<typeof createControlledTools>[0] extends infer T ? Partial<T> : never = {}) {
    return createControlledTools({
      workspacePath: workspace,
      authorizedTools: ["filesystem", "shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      approvedCommands: [["node", "-e", "console.log('ok')"]],
      ...overrides
    });
  }

  function byName(name: string) {
    const tool = tools().find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return tool;
  }

  it("lists, reads, searches, writes, and patches within the workspace", async () => {
    const list = await byName("list_files").execute({ path: "." }, ctx());
    expect(list.ok).toBe(true);
    expect(list.summary).toMatch(/readme\.md/);

    const read = await byName("read_file").execute({ path: "src/main.ts" }, ctx());
    expect(read.ok).toBe(true);
    expect(read.summary).toContain("export const x");

    const search = await byName("search_files").execute({ query: "TODO" }, ctx());
    expect(search.ok).toBe(true);
    expect(search.summary).toMatch(/readme\.md/);

    const write = await byName("write_file").execute({ path: "out/result.md", content: "done\n" }, ctx());
    expect(write.ok).toBe(true);
    expect(await readFile(join(workspace, "out", "result.md"), "utf8")).toBe("done\n");
    expect(write.artifacts).toEqual([expect.objectContaining({ path: "out/result.md", kind: "file" })]);

    const patch = await byName("apply_patch").execute({
      path: "src/main.ts",
      find: "x = 1",
      replace: "x = 2"
    }, ctx());
    // overwrite approval not wired in this unit test — patch may request approval
    if (patch.needsApproval) {
      // Re-run with allow path: use content write without onDangerousWrite
      const free = createControlledTools({
        workspacePath: workspace,
        authorizedTools: ["filesystem"],
        permissions: { workspace: "project_only", network: false, shell: false, externalSend: false }
      });
      const apply = free.find((entry) => entry.name === "apply_patch")!;
      const result = await apply.execute({ path: "src/main.ts", find: "x = 1", replace: "x = 2" }, ctx());
      expect(result.ok).toBe(true);
      expect(await readFile(join(workspace, "src", "main.ts"), "utf8")).toContain("x = 2");
      expect(result.artifacts?.some((artifact) => artifact.kind === "diff")).toBe(true);
    } else {
      expect(patch.ok).toBe(true);
      expect(await readFile(join(workspace, "src", "main.ts"), "utf8")).toContain("x = 2");
    }
  });

  it("rejects paths outside the workspace", async () => {
    expect(() => resolveWorkspacePath(workspace, "../escape.md")).toThrow(/relative|outside/i);
    const result = await byName("read_file").execute({ path: "../escape.md" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.needsApproval?.kind).toBe("outside_workspace");
  });

  it("only runs plan-approved shell/test/build commands and registers command evidence", async () => {
    const set = tools({
      runCommand: async (argv) => ({
        exitCode: 0,
        stdout: `ran ${argv.join(" ")}`,
        stderr: ""
      })
    });
    const run = set.find((entry) => entry.name === "run_command")!;
    const allowed = await run.execute({ argv: ["node", "-e", "console.log('ok')"] }, ctx());
    expect(allowed.ok).toBe(true);
    expect(allowed.summary).toContain("ran node");
    expect(allowed.artifacts?.[0]?.kind).toBe("command_result");

    const blocked = await run.execute({ argv: ["node", "-e", "console.log('nope')"] }, ctx());
    expect(blocked.ok).toBe(false);
    expect(blocked.needsApproval?.kind).toBe("unapproved_tool");

    const install = await run.execute({ command: "npm install evil" }, ctx());
    expect(install.needsApproval?.kind).toBe("system_install");
  });

  it("hides write/shell tools when Role permissions forbid them", () => {
    const readOnly = createControlledTools({
      workspacePath: workspace,
      authorizedTools: ["filesystem"],
      permissions: { workspace: "read_only", network: false, shell: false, externalSend: false }
    });
    expect(readOnly.map((tool) => tool.name).sort()).toEqual(["list_files", "read_file", "search_files"]);

    const noFs = createControlledTools({
      workspacePath: workspace,
      authorizedTools: ["shell"],
      permissions: { workspace: "project_only", network: false, shell: true, externalSend: false },
      approvedCommands: [["npm", "test"]]
    });
    expect(noFs.map((tool) => tool.name)).toEqual(["run_command"]);
  });
});
