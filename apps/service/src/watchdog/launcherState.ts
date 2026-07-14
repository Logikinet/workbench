/**
 * Persistent launcher / LKG state store (JSON on disk).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_LAUNCHER_STATE,
  type LauncherState,
  type ReleaseChannel
} from "./watchdogTypes.js";

export interface LauncherStateFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

const defaultFs: LauncherStateFs = {
  existsSync,
  readFileSync,
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding)
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeChannel(value: unknown): ReleaseChannel {
  return typeof value === "string" && value.trim().toLowerCase() === "beta" ? "beta" : "stable";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeLauncherState(parsed: unknown): LauncherState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("launcher state must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const badVersions = isStringArray(record.badVersions)
    ? [...new Set(record.badVersions.map((entry) => entry.trim()).filter(Boolean))]
    : [];
  const candidateLaunchCount = Number(record.candidateLaunchCount);
  const appliedMigrationVersion = Number(record.appliedMigrationVersion);
  const prefs =
    record.updatePreferences && typeof record.updatePreferences === "object" && !Array.isArray(record.updatePreferences)
      ? (record.updatePreferences as Record<string, unknown>)
      : {};

  return {
    channel: normalizeChannel(record.channel),
    currentVersion: normalizeOptionalString(record.currentVersion),
    previousVersion: normalizeOptionalString(record.previousVersion),
    candidateVersion: normalizeOptionalString(record.candidateVersion),
    candidateLaunchCount:
      Number.isInteger(candidateLaunchCount) && candidateLaunchCount >= 0 ? candidateLaunchCount : 0,
    lastKnownGoodVersion: normalizeOptionalString(record.lastKnownGoodVersion),
    badVersions,
    lastUpdateCheckAt: normalizeOptionalString(record.lastUpdateCheckAt),
    downloadedVersion: normalizeOptionalString(record.downloadedVersion),
    downloadedReleaseNotesUrl: normalizeOptionalString(record.downloadedReleaseNotesUrl),
    appliedMigrationVersion:
      Number.isInteger(appliedMigrationVersion) && appliedMigrationVersion >= 0
        ? appliedMigrationVersion
        : 0,
    updatePreferences: {
      automaticChecks:
        typeof prefs.automaticChecks === "boolean"
          ? prefs.automaticChecks
          : DEFAULT_LAUNCHER_STATE.updatePreferences.automaticChecks,
      autoDownload:
        typeof prefs.autoDownload === "boolean"
          ? prefs.autoDownload
          : DEFAULT_LAUNCHER_STATE.updatePreferences.autoDownload
    }
  };
}

export class LauncherStateStore {
  private readonly fs: LauncherStateFs;

  constructor(
    private readonly statePath: string,
    fsImpl: LauncherStateFs = defaultFs
  ) {
    this.fs = fsImpl;
  }

  hasStateFile(): boolean {
    return this.fs.existsSync(this.statePath);
  }

  read(): LauncherState {
    if (!this.hasStateFile()) {
      return { ...DEFAULT_LAUNCHER_STATE, badVersions: [], updatePreferences: { ...DEFAULT_LAUNCHER_STATE.updatePreferences } };
    }
    const raw = this.fs.readFileSync(this.statePath, "utf8");
    return normalizeLauncherState(JSON.parse(raw));
  }

  async write(state: LauncherState): Promise<void> {
    const dir = dirname(this.statePath);
    if (dir && dir !== this.statePath) {
      await this.fs.mkdir(dir, { recursive: true });
    }
    await this.fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async update(updater: (state: LauncherState) => LauncherState): Promise<LauncherState> {
    const next = updater(this.read());
    await this.write(next);
    return next;
  }
}
