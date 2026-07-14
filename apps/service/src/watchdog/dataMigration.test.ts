import { describe, expect, it } from "vitest";
import {
  assertWorkbenchOnlyPaths,
  DataMigrationService,
  type MigrationFs
} from "./dataMigration.js";

function memoryFs(initial: Record<string, string> = {}): MigrationFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async copyFile(src, dest) {
      const v = files.get(src);
      if (v === undefined) throw new Error(`ENOENT ${src}`);
      files.set(dest, v);
    },
    async access(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    }
  };
}

describe("assertWorkbenchOnlyPaths", () => {
  it("blocks project workspace paths and traversal", () => {
    expect(() => assertWorkbenchOnlyPaths(["workspaces/foo/bar"])).toThrow(/project workspace/);
    expect(() => assertWorkbenchOnlyPaths(["../etc/passwd"])).toThrow(/escapes/);
  });

  it("allows workbench state files", () => {
    expect(() => assertWorkbenchOnlyPaths(["settings.json", "launcher-state.json"])).not.toThrow();
  });
});

describe("DataMigrationService", () => {
  it("backs up, applies, and advances version", async () => {
    const fs = memoryFs({
      "/data/settings.json": JSON.stringify({ schema: 0 })
    });
    const migration = new DataMigrationService({
      dataDirectory: "/data",
      backupRoot: "/backups",
      fs,
      now: () => 42,
      steps: [
        {
          toVersion: 1,
          files: ["settings.json"],
          async apply(ctx) {
            await ctx.fs.writeFile(
              `${ctx.dataDirectory}/settings.json`,
              JSON.stringify({ schema: 1 }),
              "utf8"
            );
          }
        }
      ]
    });

    const result = await migration.migrate(0, 1);
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.toVersion).toBe(1);
    expect(JSON.parse(fs.files.get("/data/settings.json")!)).toEqual({ schema: 1 });
    expect(fs.files.has("/backups/migrate-0-to-1-42/settings.json")).toBe(true);
    expect(fs.files.has("/backups/migrate-0-to-1-42/migration-backup.json")).toBe(true);
    const manifest = JSON.parse(fs.files.get("/backups/migrate-0-to-1-42/migration-backup.json")!);
    expect(manifest.projectFilesExcluded).toBe(true);
  });

  it("rolls back files when apply throws", async () => {
    const fs = memoryFs({
      "/data/settings.json": JSON.stringify({ schema: 0, keep: true })
    });
    const migration = new DataMigrationService({
      dataDirectory: "/data",
      backupRoot: "/backups",
      fs,
      now: () => 7,
      steps: [
        {
          toVersion: 1,
          files: ["settings.json"],
          async apply(ctx) {
            await ctx.fs.writeFile(
              `${ctx.dataDirectory}/settings.json`,
              JSON.stringify({ schema: 1, corrupted: true }),
              "utf8"
            );
            throw new Error("boom");
          }
        }
      ]
    });

    const result = await migration.migrate(0, 1);
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(JSON.parse(fs.files.get("/data/settings.json")!)).toEqual({ schema: 0, keep: true });
  });

  it("is a no-op when already at target", async () => {
    const migration = new DataMigrationService({
      dataDirectory: "/data",
      backupRoot: "/backups",
      fs: memoryFs(),
      steps: []
    });
    const result = await migration.migrate(2, 2);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/already at target/);
  });
});
