/**
 * Workbench data migration with backup + rollback.
 *
 * NEVER mutates Project workspace files — only workbench state under the data directory
 * (settings, indexes, launcher state keys the migrator declares).
 */

import { dirname } from "node:path";
import type { MigrationBackupManifest, MigrationResult } from "./watchdogTypes.js";

/** Join data-root + relative path using `/` so tests and Windows paths stay stable. */
function joinRoot(root: string, ...parts: string[]): string {
  const segments = [
    root.replace(/[/\\]+$/u, ""),
    ...parts.flatMap((part) => part.replace(/\\/g, "/").split("/").filter(Boolean))
  ];
  // Preserve absolute POSIX-style roots used in unit tests (`/data/...`).
  if (root.startsWith("/") && !root.match(/^[a-zA-Z]:/)) {
    return `/${segments
      .join("/")
      .replace(/^\/+/u, "")
      .replace(/\/{2,}/gu, "/")}`;
  }
  if (/^[a-zA-Z]:/.test(root)) {
    const [drive, ...rest] = segments;
    return `${drive}\\${rest.join("\\").replace(/\//g, "\\")}`;
  }
  return segments.join("/").replace(/\\/g, "/");
}

export interface MigrationFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  access(path: string): Promise<void>;
  rm?(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface MigrationStep {
  /** Target schema version after this step runs. */
  toVersion: number;
  /** Relative paths under dataDirectory to snapshot before migrate. */
  files: string[];
  /**
   * Apply migration. Must not touch project workspace trees.
   * Throw to trigger rollback from backup.
   */
  apply: (ctx: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  dataDirectory: string;
  fromVersion: number;
  toVersion: number;
  fs: MigrationFs;
  /** Absolute path to the backup directory for this attempt. */
  backupDirectory: string;
}

export interface DataMigrationOptions {
  dataDirectory: string;
  backupRoot: string;
  fs: MigrationFs;
  steps: MigrationStep[];
  /**
   * Optional guard: reject any path that looks like a project workspace.
   * Defaults to blocking paths containing `/projects/` or `\\projects\\` workspace roots
   * when the step file list is empty — steps must declare explicit workbench files.
   */
  assertSafePaths?: (relativePaths: string[]) => void;
  now?: () => number;
}

const DEFAULT_BLOCKED = /(^|[/\\])(workspaces|project-files)([/\\]|$)/i;

export function assertWorkbenchOnlyPaths(relativePaths: string[]): void {
  for (const rel of relativePaths) {
    const normalized = rel.replace(/\\/g, "/");
    if (normalized.includes("..")) {
      throw new Error(`migration path escapes data directory: ${rel}`);
    }
    if (DEFAULT_BLOCKED.test(normalized)) {
      throw new Error(`migration must not touch project workspace path: ${rel}`);
    }
  }
}

export class DataMigrationService {
  private readonly now: () => number;
  private readonly assertSafePaths: (relativePaths: string[]) => void;

  constructor(private readonly options: DataMigrationOptions) {
    this.now = options.now ?? (() => Date.now());
    this.assertSafePaths = options.assertSafePaths ?? assertWorkbenchOnlyPaths;
  }

  /**
   * Run all steps with toVersion > fromVersion, ordered ascending.
   * Each step: backup declared files → apply → on failure restore backup.
   */
  async migrate(fromVersion: number, toVersion: number): Promise<MigrationResult> {
    if (!Number.isInteger(fromVersion) || fromVersion < 0) {
      throw new Error("fromVersion must be a non-negative integer");
    }
    if (!Number.isInteger(toVersion) || toVersion < 0) {
      throw new Error("toVersion must be a non-negative integer");
    }
    if (toVersion < fromVersion) {
      throw new Error(`cannot migrate backwards from ${fromVersion} to ${toVersion}`);
    }
    if (toVersion === fromVersion) {
      return {
        ok: true,
        fromVersion,
        toVersion,
        backupPath: null,
        rolledBack: false,
        detail: "already at target migration version"
      };
    }

    const steps = this.options.steps
      .filter((step) => step.toVersion > fromVersion && step.toVersion <= toVersion)
      .sort((a, b) => a.toVersion - b.toVersion);

    if (steps.length === 0) {
      return {
        ok: true,
        fromVersion,
        toVersion,
        backupPath: null,
        rolledBack: false,
        detail: "no migration steps registered for range"
      };
    }

    let current = fromVersion;
    let lastBackup: string | null = null;

    for (const step of steps) {
      this.assertSafePaths(step.files);
      const backupDirectory = joinRoot(
        this.options.backupRoot,
        `migrate-${current}-to-${step.toVersion}-${this.now()}`
      );
      lastBackup = backupDirectory;
      await this.options.fs.mkdir(backupDirectory, { recursive: true });

      const backedUp: string[] = [];
      for (const rel of step.files) {
        const src = joinRoot(this.options.dataDirectory, rel);
        const dest = joinRoot(backupDirectory, rel);
        await this.options.fs.mkdir(dirname(dest), { recursive: true });
        try {
          await this.options.fs.access(src);
          await this.options.fs.copyFile(src, dest);
          backedUp.push(rel);
        } catch {
          // missing source is ok — migrate may create the file
        }
      }

      const manifest: MigrationBackupManifest = {
        createdAt: new Date(this.now()).toISOString(),
        fromMigrationVersion: current,
        toMigrationVersion: step.toVersion,
        files: backedUp,
        projectFilesExcluded: true
      };
      await this.options.fs.writeFile(
        joinRoot(backupDirectory, "migration-backup.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
      );

      try {
        await step.apply({
          dataDirectory: this.options.dataDirectory,
          fromVersion: current,
          toVersion: step.toVersion,
          fs: this.options.fs,
          backupDirectory
        });
        current = step.toVersion;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.restoreBackup(backupDirectory, backedUp);
        return {
          ok: false,
          fromVersion,
          toVersion: current,
          backupPath: backupDirectory,
          rolledBack: true,
          detail: `migration to ${step.toVersion} failed and was rolled back: ${message}`
        };
      }
    }

    return {
      ok: true,
      fromVersion,
      toVersion: current,
      backupPath: lastBackup,
      rolledBack: false,
      detail: `migrated workbench data from ${fromVersion} to ${current}`
    };
  }

  private async restoreBackup(backupDirectory: string, files: string[]): Promise<void> {
    for (const rel of files) {
      const src = joinRoot(backupDirectory, rel);
      const dest = joinRoot(this.options.dataDirectory, rel);
      await this.options.fs.mkdir(dirname(dest), { recursive: true });
      await this.options.fs.copyFile(src, dest);
    }
  }
}
