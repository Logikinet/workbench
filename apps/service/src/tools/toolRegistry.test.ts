import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "./toolRegistry.js";
import { TOOL_PERMISSION_CATEGORIES } from "./toolTypes.js";

describe("ToolRegistry", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-tools-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seeds built-in tools across readonly / write / shell / network / dangerous categories", async () => {
    const tools = await ToolRegistry.createMemory();
    const listed = tools.list();
    expect(listed.length).toBeGreaterThanOrEqual(6);

    const byCategory = Object.fromEntries(
      TOOL_PERMISSION_CATEGORIES.map((category) => [category, tools.list({ category })])
    ) as Record<string, ReturnType<ToolRegistry["list"]>>;

    expect(byCategory.readonly.some((tool) => tool.id === "read_file")).toBe(true);
    expect(byCategory.write.some((tool) => tool.id === "filesystem")).toBe(true);
    expect(byCategory.shell.some((tool) => tool.id === "shell")).toBe(true);
    expect(byCategory.network.some((tool) => tool.id === "web")).toBe(true);
    expect(byCategory.dangerous.some((tool) => tool.id === "dangerous_exec")).toBe(true);

    // Shell / network / dangerous require approval by default.
    expect(tools.get("shell").requiresApproval).toBe(true);
    expect(tools.get("web").requiresApproval).toBe(true);
    expect(tools.get("dangerous_exec").requiresApproval).toBe(true);
  });

  it("registers, enables, disables, and trusts non-built-in tools", async () => {
    const tools = await ToolRegistry.open({ statePath: join(root, "tools.json") });
    const registered = await tools.register({
      id: "custom-search",
      name: "custom-search",
      description: "Custom search tool",
      category: "network",
      trusted: false
    });
    expect(registered.trusted).toBe(false);
    expect(registered.enabled).toBe(true);

    await tools.setEnabled("custom-search", false);
    expect(tools.get("custom-search").enabled).toBe(false);

    await tools.setEnabled("custom-search", true);
    await tools.trust("custom-search");
    expect(tools.get("custom-search").trusted).toBe(true);
    expect(tools.get("custom-search").trustedAt).toBeTruthy();

    // Persistence round-trip
    const reopened = await ToolRegistry.open({ statePath: join(root, "tools.json") });
    expect(reopened.get("custom-search").trusted).toBe(true);
    expect(reopened.get("filesystem").source).toBe("builtin");
  });

  it("resolves name-only Role tool names to catalog ids", async () => {
    const tools = await ToolRegistry.createMemory();
    expect(tools.resolveByNameOrId("filesystem")?.id).toBe("filesystem");
    expect(tools.resolveByNameOrId("codex-cli")?.name).toBe("codex-cli");
    expect(tools.resolveByNameOrId("nope")).toBeUndefined();
  });

  it("rejects invalid categories and duplicate registration", async () => {
    const tools = await ToolRegistry.createMemory();
    await expect(
      tools.register({
        id: "x",
        name: "x",
        description: "x",
        category: "laser" as "readonly"
      })
    ).rejects.toThrow(/category/i);

    await expect(
      tools.register({
        id: "filesystem",
        name: "filesystem",
        description: "dup",
        category: "write"
      })
    ).rejects.toThrow(/already registered/i);
  });

  it("does not allow revoking trust on ordinary built-ins", async () => {
    const tools = await ToolRegistry.createMemory();
    await expect(tools.revokeTrust("filesystem")).rejects.toThrow(/built-in/i);
  });
});
