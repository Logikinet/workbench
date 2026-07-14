/**
 * Plugin / Extension SDK contract tests (Task 46).
 * Covers manifest, lifecycle, permission isolation, process isolation,
 * contribution kinds, config/secrets split, and core compatibility.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPluginCompatibility,
  compareSemverLike,
  isApiVersionCompatible
} from "./pluginCompat.js";
import { PluginHost } from "./pluginHost.js";
import {
  PluginManifestError,
  loadPluginManifest,
  parsePluginManifest
} from "./pluginManifest.js";
import {
  assertPermission,
  permissionForContribution,
  validatePermissionApproval
} from "./pluginPermissions.js";
import { PluginContributionRegistry } from "./pluginRegistry.js";
import { MemoryPluginVault, PluginService } from "./pluginService.js";
import {
  PLUGIN_API_VERSION,
  PLUGIN_CONTRIBUTION_KINDS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginPermission
} from "./pluginTypes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_HELLO = join(HERE, "sample", "hello-tool");

describe("Plugin/Extension SDK contract (Task 46)", () => {
  let root: string;
  let installRoot: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-plugin-"));
    installRoot = join(root, "installed-plugins");
    statePath = join(root, "plugins-state.json");
    await mkdir(installRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function openService(coreVersion = "0.1.0"): Promise<PluginService> {
    return PluginService.open({
      statePath,
      installRoot,
      coreVersion,
      vault: new MemoryPluginVault()
    });
  }

  async function writePackage(
    dir: string,
    manifest: PluginManifest,
    mainBody?: string
  ): Promise<string> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");
    const main = mainBody ?? defaultMainModule(manifest);
    await writeFile(join(dir, manifest.entry.main), main, "utf8");
    return dir;
  }

  function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      id: "fixture-plugin",
      name: "Fixture Plugin",
      version: "1.0.0",
      description: "Test fixture",
      apiVersion: "1",
      engine: { minCoreVersion: "0.1.0", maxCoreVersion: "2.0.0" },
      entry: { type: "inprocess", main: "main.mjs" },
      permissions: ["tool.register"],
      contributes: {
        tools: [
          {
            id: "fixture.echo",
            name: "fixture.echo",
            description: "Echo",
            category: "readonly"
          }
        ]
      },
      ...overrides
    };
  }

  // ---------------------------------------------------------------------------
  // Manifest / API version / entry / capabilities / permissions / schema / compat
  // ---------------------------------------------------------------------------

  it("defines a stable manifest with API version, entry, permissions, config/secrets schema, contributes", async () => {
    const manifest = parsePluginManifest({
      id: "demo",
      name: "Demo",
      version: "1.2.3",
      apiVersion: PLUGIN_API_VERSION,
      engine: { minCoreVersion: "0.1.0", maxCoreVersion: "3.0.0" },
      entry: { type: "stdio", main: "main.mjs", command: "node" },
      permissions: ["tool.register", "network"],
      configSchema: { type: "object", properties: { theme: { type: "string" } } },
      secretsSchema: { keys: ["apiToken"] },
      contributes: {
        tools: [{ id: "t1", name: "t1", category: "network" }],
        providers: [{ id: "p1", name: "P1", providerKind: "openai_compatible" }]
      }
    });

    expect(manifest.apiVersion).toBe("1");
    expect(manifest.entry.type).toBe("stdio");
    expect(manifest.entry.main).toBe("main.mjs");
    expect(manifest.permissions).toEqual(["tool.register", "network"]);
    expect(manifest.configSchema).toMatchObject({ type: "object" });
    expect(manifest.secretsSchema?.keys).toEqual(["apiToken"]);
    expect(manifest.engine.minCoreVersion).toBe("0.1.0");
    expect(manifest.contributes.tools?.[0].id).toBe("t1");
    expect(manifest.contributes.providers?.[0].id).toBe("p1");
    expect(PLUGIN_PERMISSIONS).toContain("tool.register");
    expect(PLUGIN_CONTRIBUTION_KINDS).toEqual(
      expect.arrayContaining([
        "provider",
        "harness",
        "tool",
        "skill_source",
        "artifact_renderer",
        "trigger"
      ])
    );
  });

  it("rejects invalid manifests (missing id, unknown permission, empty contributes)", () => {
    expect(() => parsePluginManifest({ name: "x", version: "1", apiVersion: "1" })).toThrow(
      PluginManifestError
    );
    expect(() =>
      parsePluginManifest({
        id: "x",
        name: "x",
        version: "1",
        apiVersion: "1",
        engine: { minCoreVersion: "0.1.0" },
        entry: { type: "inprocess", main: "main.mjs" },
        permissions: ["not-a-real-perm"],
        contributes: { tools: [{ id: "t", name: "t", category: "readonly" }] }
      })
    ).toThrow(/Unknown permission/i);
    expect(() =>
      parsePluginManifest({
        id: "x",
        name: "x",
        version: "1",
        apiVersion: "1",
        engine: { minCoreVersion: "0.1.0" },
        entry: { type: "inprocess", main: "main.mjs" },
        permissions: [],
        contributes: {}
      })
    ).toThrow(/at least one/i);
  });

  it("loads the sample hello-tool package from disk", async () => {
    const resolved = await loadPluginManifest(SAMPLE_HELLO);
    expect(resolved.id).toBe("hello-tool");
    expect(resolved.contributes.tools?.[0].id).toBe("hello.greet");
    expect(resolved.rootDir).toContain("hello-tool");
  });

  // ---------------------------------------------------------------------------
  // Install / enable / disable / update / rollback / uninstall
  // ---------------------------------------------------------------------------

  it("installs, enables, disables, updates, rolls back, and uninstalls locally", async () => {
    const svc = await openService();
    const v1Dir = join(root, "pkg-v1");
    await writePackage(v1Dir, baseManifest({ version: "1.0.0" }));

    await expect(
      svc.install({
        sourcePath: v1Dir,
        approvedPermissions: ["tool.register"],
        confirm: false as unknown as true
      })
    ).rejects.toThrow(/confirm/i);

    const installed = await svc.install({
      sourcePath: v1Dir,
      approvedPermissions: ["tool.register"],
      confirm: true,
      config: { greeting: "Hi" }
    });
    expect(installed).toMatchObject({
      id: "fixture-plugin",
      version: "1.0.0",
      enabled: false,
      status: "installed",
      secretsExcluded: true
    });
    expect(installed.config).toMatchObject({ greeting: "Hi" });

    const enabled = await svc.enable("fixture-plugin");
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe("enabled");
    expect(svc.registry.list("tool").some((t) => t.contributionId === "fixture.echo")).toBe(true);
    expect(svc.getHost().isRunning("fixture-plugin")).toBe(true);

    const pong = await svc.requestPlugin<{ pong: boolean }>("fixture-plugin", "plugin.ping");
    expect(pong.pong).toBe(true);

    const disabled = await svc.disable("fixture-plugin");
    expect(disabled.enabled).toBe(false);
    expect(disabled.status).toBe("disabled");
    expect(svc.getHost().isRunning("fixture-plugin")).toBe(false);
    expect(svc.registry.list("tool")).toHaveLength(0);

    // Update to 1.1.0
    const v2Dir = join(root, "pkg-v2");
    await writePackage(
      v2Dir,
      baseManifest({
        version: "1.1.0",
        contributes: {
          tools: [
            {
              id: "fixture.echo",
              name: "fixture.echo",
              description: "Echo v2",
              category: "readonly"
            }
          ]
        }
      })
    );
    await svc.enable("fixture-plugin");
    const updated = await svc.update({
      pluginId: "fixture-plugin",
      sourcePath: v2Dir,
      confirm: true
    });
    expect(updated.version).toBe("1.1.0");
    expect(updated.enabled).toBe(true);
    expect(svc.getInstallRecord("fixture-plugin").history.length).toBeGreaterThanOrEqual(1);
    expect(svc.getInstallRecord("fixture-plugin").history[0]?.version).toBe("1.0.0");

    const rolled = await svc.rollback({ pluginId: "fixture-plugin", confirm: true });
    expect(rolled.version).toBe("1.0.0");

    await svc.uninstall("fixture-plugin", { confirm: true });
    expect(svc.tryGet("fixture-plugin")).toBeUndefined();
    expect(svc.list()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Permission isolation
  // ---------------------------------------------------------------------------

  it("only grants manifest-declared permissions that the operator approved", async () => {
    const approval = validatePermissionApproval({
      declared: ["tool.register", "network"],
      approved: ["tool.register"]
    });
    expect(approval.ok).toBe(false);
    if (!approval.ok) {
      expect(approval.denials.some((d) => d.permission === "network")).toBe(true);
    }

    const ok = validatePermissionApproval({
      declared: ["tool.register", "network"],
      approved: ["tool.register", "network"]
    });
    expect(ok.ok).toBe(true);

    // Cannot approve undeclared permission
    const over = validatePermissionApproval({
      declared: ["tool.register"],
      approved: ["tool.register", "shell"],
      requireAllDeclared: false
    });
    expect(over.ok).toBe(false);

    const registry = new PluginContributionRegistry();
    expect(() =>
      registry.registerFromManifest({
        pluginId: "p",
        contributes: {
          tools: [{ id: "t", name: "t", category: "readonly" }],
          providers: [{ id: "prov", name: "Prov" }]
        },
        approvedPermissions: ["tool.register"] // missing provider.register
      })
    ).toThrow(/provider\.register/i);

    expect(() => assertPermission(["tool.register"], "shell", "run shell")).toThrow(
      /not permitted/i
    );
    expect(permissionForContribution("trigger")).toBe("trigger.register");
  });

  it("rejects install when operator does not approve declared permissions", async () => {
    const svc = await openService();
    const dir = join(root, "needs-network");
    await writePackage(
      dir,
      baseManifest({
        id: "needs-network",
        permissions: ["tool.register", "network"]
      })
    );
    await expect(
      svc.install({
        sourcePath: dir,
        approvedPermissions: ["tool.register"],
        confirm: true
      })
    ).rejects.toThrow(/Permission approval failed/i);
  });

  // ---------------------------------------------------------------------------
  // Process isolation — crash does not take down host
  // ---------------------------------------------------------------------------

  it("isolates third-party plugins so a crash does not stop the workbench host", async () => {
    const svc = await openService();
    const dir = join(root, "crashy");
    await writePackage(dir, baseManifest({ id: "crashy" }));
    await svc.install({
      sourcePath: dir,
      approvedPermissions: ["tool.register"],
      confirm: true
    });
    await svc.enable("crashy");
    expect(svc.getHost().isRunning("crashy")).toBe(true);

    // Host still usable after simulated plugin crash
    let hostAlive = true;
    try {
      svc.getHost().simulateCrash("crashy", "boom");
      await new Promise((r) => setTimeout(r, 20));
      await svc.handlePluginCrash("crashy", "boom");
      const other = await openService(); // host service pattern: new ops still work
      void other;
      const row = svc.get("crashy");
      expect(row.status).toBe("crashed");
      expect(row.enabled).toBe(false);
      expect(svc.getHost().isRunning("crashy")).toBe(false);
      // Service itself still answers list/get
      expect(svc.list().map((p) => p.id)).toContain("crashy");
    } catch {
      hostAlive = false;
    }
    expect(hostAlive).toBe(true);

    // Can still install another plugin on the same service after crash
    const dir2 = join(root, "survivor");
    await writePackage(dir2, baseManifest({ id: "survivor" }));
    const survivor = await svc.install({
      sourcePath: dir2,
      approvedPermissions: ["tool.register"],
      confirm: true
    });
    expect(survivor.id).toBe("survivor");
    await svc.shutdown();
  });

  it("stdio plugin process isolation serves ping without loading into host heap path", async () => {
    const dir = join(root, "stdio-hello");
    const stdioMain = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type !== "request") return;
    if (msg.kind === "plugin.ping") {
      process.stdout.write(JSON.stringify({ type: "response", requestId: msg.requestId, ok: true, data: { pong: true, mode: "stdio" } }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ type: "response", requestId: msg.requestId, ok: false, error: { message: "unknown" } }) + "\\n");
  } catch {}
});
`;
    await writePackage(
      dir,
      baseManifest({
        id: "stdio-hello",
        entry: { type: "stdio", main: "main.mjs" }
      }),
      stdioMain
    );

    const host = new PluginHost({ requestTimeoutMs: 5000 });
    const resolved = await loadPluginManifest(dir);
    const handle = await host.start(resolved);
    expect(handle.entryType).toBe("stdio");
    expect(handle.pid).toBeTypeOf("number");
    const data = await handle.request<{ pong: boolean; mode: string }>("plugin.ping");
    expect(data).toMatchObject({ pong: true, mode: "stdio" });
    await host.stop("stdio-hello");
    await host.stopAll();
  });

  // ---------------------------------------------------------------------------
  // All six contribution kinds registerable
  // ---------------------------------------------------------------------------

  it("registers Provider, Harness, Tool, Skill Source, Artifact Renderer, and Trigger via extensions", async () => {
    const svc = await openService();
    const dir = join(root, "full-surface");
    const permissions: PluginPermission[] = [
      "provider.register",
      "harness.register",
      "tool.register",
      "skill_source.register",
      "artifact_renderer.register",
      "trigger.register"
    ];
    await writePackage(
      dir,
      baseManifest({
        id: "full-surface",
        permissions,
        contributes: {
          providers: [{ id: "ext.provider", name: "Ext Provider", providerKind: "custom" }],
          harnesses: [{ id: "ext.harness", name: "Ext Harness", capabilities: ["tools"] }],
          tools: [{ id: "ext.tool", name: "ext.tool", category: "readonly" }],
          skillSources: [{ id: "ext.skills", name: "Ext Skills", rootHint: "skills" }],
          artifactRenderers: [
            {
              id: "ext.render.md",
              name: "Markdown Renderer",
              mimeTypes: ["text/markdown"],
              extensions: [".md"]
            }
          ],
          triggers: [{ id: "ext.trigger.cron", name: "Nightly", kind: "cron" }]
        }
      })
    );

    await svc.install({
      sourcePath: dir,
      approvedPermissions: permissions,
      confirm: true
    });
    await svc.enable("full-surface");

    for (const kind of PLUGIN_CONTRIBUTION_KINDS) {
      const list = svc.registry.list(kind);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.every((e) => e.pluginId === "full-surface")).toBe(true);
    }

    const detail = await svc.getDetail("full-surface");
    expect(detail.contributes.providers?.[0].id).toBe("ext.provider");
    expect(detail.contributes.harnesses?.[0].id).toBe("ext.harness");
    expect(detail.contributes.tools?.[0].id).toBe("ext.tool");
    expect(detail.contributes.skillSources?.[0].id).toBe("ext.skills");
    expect(detail.contributes.artifactRenderers?.[0].mimeTypes).toContain("text/markdown");
    expect(detail.contributes.triggers?.[0].kind).toBe("cron");

    await svc.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Config / secrets separation — ordinary backup excludes secret values
  // ---------------------------------------------------------------------------

  it("separates config from secrets; backup slice never includes secret values", async () => {
    const vault = new MemoryPluginVault();
    const svc = await PluginService.open({
      statePath,
      installRoot,
      coreVersion: "0.1.0",
      vault
    });
    const dir = join(root, "secretive");
    await writePackage(
      dir,
      baseManifest({
        id: "secretive",
        secretsSchema: { keys: ["apiToken", "webhookSecret"] },
        configSchema: {
          type: "object",
          properties: { endpoint: { type: "string" } }
        }
      })
    );

    await svc.install({
      sourcePath: dir,
      approvedPermissions: ["tool.register"],
      confirm: true,
      config: {
        endpoint: "https://example.local",
        apiKey: "should-be-stripped-from-config"
      },
      secrets: {
        apiToken: "super-secret-token-value",
        webhookSecret: "whsec_test"
      }
    });

    const publicRow = svc.get("secretive");
    expect(publicRow.config.endpoint).toBe("https://example.local");
    expect(publicRow.config.apiKey).toBeUndefined();
    expect(publicRow.secretKeys).toEqual(["apiToken", "webhookSecret"]);
    expect(publicRow.secretsExcluded).toBe(true);
    expect(JSON.stringify(publicRow)).not.toContain("super-secret-token-value");
    expect(JSON.stringify(publicRow)).not.toContain("whsec_test");

    const backup = svc.exportBackupSlice();
    expect(backup.secretsExcluded).toBe(true);
    const blob = JSON.stringify(backup);
    expect(blob).not.toContain("super-secret-token-value");
    expect(blob).not.toContain("whsec_test");
    expect(backup.plugins[0]?.secretKeys).toEqual(["apiToken", "webhookSecret"]);
    expect(backup.plugins[0]?.config).toMatchObject({ endpoint: "https://example.local" });

    // Secrets remain in vault only
    const secrets = await svc.readSecrets("secretive");
    expect(secrets?.apiToken).toBe("super-secret-token-value");

    // Persisted state file also secret-free
    const rawState = await readFile(statePath, "utf8");
    expect(rawState).not.toContain("super-secret-token-value");
  });

  // ---------------------------------------------------------------------------
  // Core upgrade compatibility → auto-disable incompatible
  // ---------------------------------------------------------------------------

  it("checks extension compatibility on core upgrade and auto-disables incompatible plugins", async () => {
    expect(isApiVersionCompatible("1", "1")).toBe(true);
    expect(isApiVersionCompatible("2", "1")).toBe(false);
    expect(compareSemverLike("1.2.0", "1.10.0")).toBeLessThan(0);

    const svc = await openService("0.5.0");
    const dir = join(root, "range-limited");
    await writePackage(
      dir,
      baseManifest({
        id: "range-limited",
        engine: { minCoreVersion: "0.1.0", maxCoreVersion: "1.0.0" },
        apiVersion: "1"
      })
    );
    await svc.install({
      sourcePath: dir,
      approvedPermissions: ["tool.register"],
      confirm: true
    });
    await svc.enable("range-limited");
    expect(svc.get("range-limited").status).toBe("enabled");

    const results = await svc.applyCoreCompatibility("1.5.0");
    expect(results.some((r) => r.pluginId === "range-limited" && !r.compatible)).toBe(true);

    const row = svc.get("range-limited");
    expect(row.enabled).toBe(false);
    expect(row.status).toBe("incompatible");
    expect(row.lastError).toMatch(/outside plugin engine range|Core version/i);
    expect(svc.getHost().isRunning("range-limited")).toBe(false);

    // API major mismatch
    const apiDir = join(root, "api-v2");
    await writePackage(
      apiDir,
      baseManifest({
        id: "api-v2",
        apiVersion: "2",
        engine: { minCoreVersion: "0.1.0" }
      })
    );
    // Install is allowed but marked incompatible when core check fails at enable/compat
    // parse allows apiVersion 2; host marks incompatible via check
    const compat = checkPluginCompatibility(
      {
        id: "api-v2",
        version: "1.0.0",
        apiVersion: "2",
        engine: { minCoreVersion: "0.1.0" }
      },
      "0.5.0"
    );
    expect(compat.compatible).toBe(false);
    expect(compat.apiVersionOk).toBe(false);

    await expect(
      svc.install({
        sourcePath: apiDir,
        approvedPermissions: ["tool.register"],
        confirm: true
      }).then(async (row) => {
        expect(row.status).toBe("incompatible");
        await expect(svc.enable("api-v2")).rejects.toThrow(/incompatible/i);
      })
    ).resolves.toBeUndefined();

    await svc.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Sample plugin end-to-end
  // ---------------------------------------------------------------------------

  it("runs the minimal sample hello-tool extension end-to-end", async () => {
    const svc = await openService("0.1.0");
    const installed = await svc.install({
      sourcePath: SAMPLE_HELLO,
      approvedPermissions: ["tool.register"],
      confirm: true,
      config: { greeting: "Hello" }
    });
    expect(installed.id).toBe("hello-tool");
    expect(installed.version).toBe("1.0.0");

    const enabled = await svc.enable("hello-tool");
    expect(enabled.status).toBe("enabled");
    expect(svc.registry.get("tool", "hello.greet")?.pluginId).toBe("hello-tool");

    const greet = await svc.requestPlugin<{ message: string }>("hello-tool", "hello.greet", {
      name: "Operator"
    });
    expect(greet.message).toMatch(/Hello, Operator/);

    const detail = await svc.getDetail("hello-tool");
    expect(detail.contributes.tools?.[0].id).toBe("hello.greet");

    await svc.shutdown();
  });
});

function defaultMainModule(manifest: PluginManifest): string {
  return `
const contributions = ${JSON.stringify(manifest.contributes)};
export async function handle(request) {
  if (request.kind === "plugin.ping") return { pong: true, pluginId: ${JSON.stringify(manifest.id)} };
  if (request.kind === "plugin.contributions") return { contributes: contributions };
  return { ok: true, kind: request.kind };
}
export { contributions };
export default { handle, contributions };
`;
}
