/**
 * Runtime watchdog + safe update rollback types (Task 45).
 *
 * Inspired by NextClaw Desktop Launcher/Runtime layering:
 * - waitForHealth + exponential restart (computeRuntimeRestartDelayMs)
 * - Candidate → Last Known Good bundle lifecycle
 * - Signed update manifests + migrationVersion
 *
 * Firstmate / UI must use these machine fields — never parse UI copy.
 */

// ── Restart / recovery ───────────────────────────────────────────────────────

/** Lifecycle of the managed Agent Service process (control plane stays up). */
export type WatchdogProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "recovering"
  | "failed"
  | "stopping";

export type WatchdogRecoveryState =
  | "idle"
  | "scheduled"
  | "attempting"
  | "stopped-by-user"
  | "exhausted";

export interface WatchdogRestartPolicy {
  /** Base delay for attempt 1 (NextClaw default: 500). */
  baseDelayMs: number;
  /** Cap on exponential delay (NextClaw default: 15_000). */
  maxDelayMs: number;
  /** Hard limit on automatic recovery attempts (0 = unlimited). */
  maxAttempts: number;
}

export const DEFAULT_RESTART_POLICY: WatchdogRestartPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 10
};

export interface RuntimeProcessExitInfo {
  code: number | null;
  signal: string | null;
  expected: boolean;
}

export interface WatchdogRuntimeSnapshot {
  generatedAt: string;
  processState: WatchdogProcessState;
  recoveryState: WatchdogRecoveryState;
  pid: number | null;
  /** Actual bound port discovered after health (PWA must not guess). */
  port: number | null;
  bindHost: string;
  baseUrl: string | null;
  healthUrl: string | null;
  healthOk: boolean;
  restartAttempt: number;
  maxAttempts: number;
  nextRestartAt: string | null;
  lastExit: RuntimeProcessExitInfo | null;
  lastError: string | null;
  /** One-click recovery stop is available while recovering/scheduled. */
  canStopRecovery: boolean;
  detail: string;
}

// ── Bundle / update manifests ────────────────────────────────────────────────

export type ReleaseChannel = "stable" | "beta";

/** On-disk application bundle metadata (inside each versioned install). */
export interface BundleManifest {
  bundleVersion: string;
  platform: string;
  arch: string;
  /** PWA / web assets version. */
  uiVersion: string;
  /** Agent service / runtime version. */
  runtimeVersion: string;
  /** Minimum compatible tray/launcher version. */
  minLauncherVersion: string;
  /** Monotonic data schema migration version. */
  migrationVersion: number;
  entrypoints: {
    /** Relative path to service entry (e.g. service/dist/main.js). */
    serviceEntry: string;
  };
  /** Optional package integrity hash of the bundle archive. */
  bundleSha256?: string;
}

/** Remote update advertisement (checked by UI / coordinator). */
export interface UpdateManifest {
  channel: ReleaseChannel | string;
  platform: string;
  arch: string;
  latestVersion: string;
  minimumLauncherVersion: string;
  bundleUrl: string;
  /** Hex SHA-256 of the download payload. */
  bundleSha256: string;
  /** Base64 Ed25519 signature over the raw bundle bytes (or HMAC when configured). */
  bundleSignature: string;
  /** Base64 Ed25519/HMAC signature over the canonical unsigned manifest JSON. */
  manifestSignature: string;
  releaseNotesUrl: string | null;
  /** Optional migration target declared by the update. */
  migrationVersion?: number;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "applying"
  | "up-to-date"
  | "blocked"
  | "failed"
  | "rolled-back";

export interface UpdateProgress {
  phase: "download" | "verify" | "extract" | "migrate" | "activate";
  bytesReceived?: number;
  bytesTotal?: number;
  percent?: number;
  detail?: string;
}

/**
 * UI-facing update snapshot — explains whether restart is required.
 */
export interface UpdateSnapshot {
  generatedAt: string;
  status: UpdateStatus;
  channel: ReleaseChannel | string;
  launcherVersion: string;
  currentVersion: string | null;
  lastKnownGoodVersion: string | null;
  candidateVersion: string | null;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseNotesUrl: string | null;
  lastCheckedAt: string | null;
  progress: UpdateProgress | null;
  canCheck: boolean;
  canDownload: boolean;
  canApply: boolean;
  /** True when apply activated a candidate that needs process restart / health gate. */
  requiresRestart: boolean;
  /** Bad versions that must not be re-installed automatically. */
  badVersions: string[];
  blockReason: string | null;
  errorMessage: string | null;
  detail: string;
}

// ── Launcher / LKG state ─────────────────────────────────────────────────────

export interface LauncherState {
  channel: ReleaseChannel;
  currentVersion: string | null;
  previousVersion: string | null;
  candidateVersion: string | null;
  candidateLaunchCount: number;
  lastKnownGoodVersion: string | null;
  badVersions: string[];
  lastUpdateCheckAt: string | null;
  downloadedVersion: string | null;
  downloadedReleaseNotesUrl: string | null;
  /** Workbench data schema version currently applied (not project files). */
  appliedMigrationVersion: number;
  updatePreferences: {
    automaticChecks: boolean;
    autoDownload: boolean;
  };
}

export const DEFAULT_LAUNCHER_STATE: LauncherState = {
  channel: "stable",
  currentVersion: null,
  previousVersion: null,
  candidateVersion: null,
  candidateLaunchCount: 0,
  lastKnownGoodVersion: null,
  badVersions: [],
  lastUpdateCheckAt: null,
  downloadedVersion: null,
  downloadedReleaseNotesUrl: null,
  appliedMigrationVersion: 0,
  updatePreferences: {
    automaticChecks: true,
    autoDownload: false
  }
};

export interface BundleActivationResult {
  activatedVersion: string;
  previousVersion: string | null;
  role: "candidate";
}

export interface BundleRollbackResult {
  rolledBackFrom: string;
  rolledBackTo: string | null;
  markedBad: true;
}

export interface BundleHealthyResult {
  version: string;
  lastKnownGoodVersion: string;
}

// ── Data migration (workbench state only — never Project files) ──────────────

export interface MigrationBackupManifest {
  createdAt: string;
  fromMigrationVersion: number;
  toMigrationVersion: number;
  /** Paths relative to data directory that were snapshotted. */
  files: string[];
  /** Explicitly excludes project workspace trees. */
  projectFilesExcluded: true;
}

export interface MigrationResult {
  ok: boolean;
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
  rolledBack: boolean;
  detail: string;
}

// ── HTTP contract ────────────────────────────────────────────────────────────

export const WATCHDOG_OPERATION_CONTRACT = {
  name: "runtime-watchdog-update-rollback",
  version: 1,
  operations: [
    { method: "GET", path: "/api/watchdog/contract", purpose: "schema for Firstmate" },
    { method: "GET", path: "/api/watchdog/runtime", purpose: "process + recovery status + actual port" },
    { method: "POST", path: "/api/watchdog/recovery/stop", purpose: "one-click stop recovery loop" },
    { method: "POST", path: "/api/watchdog/recovery/reset", purpose: "clear exhausted state to allow restarts" },
    { method: "GET", path: "/api/watchdog/update", purpose: "update snapshot for UI" },
    { method: "POST", path: "/api/watchdog/update/check", purpose: "check remote update manifest" },
    { method: "POST", path: "/api/watchdog/update/download", purpose: "download + verify candidate bundle" },
    { method: "POST", path: "/api/watchdog/update/apply", purpose: "activate candidate (requires restart)" },
    { method: "POST", path: "/api/watchdog/bundle/mark-healthy", purpose: "promote current to LKG after health gate" },
    { method: "POST", path: "/api/watchdog/bundle/recover-candidate", purpose: "rollback pending candidate to LKG" }
  ],
  notes: [
    "Tray/Launcher control plane must stay up when Agent Service crashes.",
    "PWA discovers port from runtime snapshot — never hard-code guessed ports.",
    "Updates stage as candidate; LKG only after health gate.",
    "Data migration backs up workbench state only; Project workspace files are never mutated by updates."
  ]
} as const;

export type WatchdogOperationContract = typeof WATCHDOG_OPERATION_CONTRACT;
