/**
 * Focused unit tests for PluginService helpers and edge cases (Task 46).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "./pluginManifest.js";
import { MemoryPluginVault, PluginService } from "./pluginService.js";
import { PLUGIN_MANIFEST_FILE, type PluginManifest } from "./pluginTypes.js";

describe("PluginService unit", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-plugin-unit-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists install inventory and reloads from statePath", async () => {
    const installRoot = join(root, "plugins");
    const statePath = join(root, "state.json");
    const pkg = join(root, "pkg");
    const manifest: PluginManifest = {
      id: "persist-me",
      name: "Persist Me",
      version: "1.0.0",
      apiVersion: "1",
      engine: { minCoreVersion: "0.1.0" },
      entry: { type: "inprocess", main: "main.mjs" },
      permissions: ["tool.register"],
      contributes: {
        tools: [{ id: "p.t", name: "p.t", category: "readonly" }]
      }
    };
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest), "utf8");
    await writeFile(
      join(pkg, "main.mjs"),
      `export default { contributions: ${JSON.stringify(manifest.contributes)}, handle: async () => ({ ok: true }) };\n`,
      "utf8"
    );

    const svc1 = await PluginService.open({
      statePath,
      installRoot,
      coreVersion: "0.1.0",
      vault: new MemoryPluginVault()
    });
    await svc1.install({
      sourcePath: pkg,
      approvedPermissions: ["tool.register"],
      confirm: true
    });
    await svc1.shutdown();

    const svc2 = await PluginService.open({
      statePath,
      installRoot,
      coreVersion: "0.1.0",
      vault: new MemoryPluginVault()
    });
    expect(svc2.get("persist-me").version).toBe("1.0.0");
    expect(svc2.get("persist-me").status).toBe("installed");
    await svc2.shutdown();
  });

  it("parsePluginManifest normalizes permissions and rejects bad entry type", () => {
    const m = parsePluginManifest({
      id: "x",
      name: "X",
      version: "1.0.0",
      apiVersion: "1",
      engine: { minCoreVersion: "0.1.0" },
      entry: { type: "inprocess", main: "main.js" },
      permissions: ["tool.register", "tool.register"],
      contributes: { tools: [{ id: "t", name: "t", category: "readonly" }] }
    });
    expect(m.permissions).toEqual(["tool.register"]);
    expect(() =>
      parsePluginManifest({
        id: "x",
        name: "X",
        version: "1.0.0",
        apiVersion: "1",
        engine: { minCoreVersion: "0.1.0" },
        entry: { type: "wasm", main: "main.wasm" },
        permissions: [],
        contributes: { tools: [{ id: "t", name: "t", category: "readonly" }] }
      })
    ).toThrow(/stdio|inprocess/i);
  });
});
