/**
 * Update check / download / apply coordinator for UI.
 *
 * Flow: check signed manifest → download + verify integrity/signature →
 * store as downloaded → apply activates candidate (requiresRestart) →
 * health gate (outside) → markHealthy / failCandidate.
 */

import type { VerifySignatureOptions } from "./integrity.js";
import type { LauncherStateStore } from "./launcherState.js";
import {
  isLauncherCompatible,
  parseUpdateManifest,
  verifyBundlePayload,
  verifyUpdateManifestSignature
} from "./manifests.js";
import type { BundleLifecycleService } from "./bundleLifecycle.js";
import type { DataMigrationService } from "./dataMigration.js";
import type {
  ReleaseChannel,
  UpdateManifest,
  UpdateProgress,
  UpdateSnapshot,
  UpdateStatus
} from "./watchdogTypes.js";

export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface BundleInstallStore {
  /**
   * Persist verified bundle bytes for a version (extract archive, write version dir).
   * Must make layout.resolveVersion(version) succeed afterwards.
   */
  installVersion(version: string, bytes: Buffer, manifest: UpdateManifest): Promise<{ directory: string }>;
  hasVersion(version: string): boolean;
}

export interface UpdateCoordinatorOptions {
  launcherVersion: string;
  channel?: ReleaseChannel | string;
  platform?: string;
  arch?: string;
  stateStore: LauncherStateStore;
  lifecycle: BundleLifecycleService;
  installStore: BundleInstallStore;
  /** Signature verification for manifest + bundle. */
  verify: VerifySignatureOptions;
  /** Optional remote manifest URL; required for check/download. */
  manifestUrl?: string | null;
  fetchImpl?: (url: string) => Promise<UpdateFetchResponse>;
  migration?: DataMigrationService;
  now?: () => number;
  onSnapshot?: (snapshot: UpdateSnapshot) => void;
}

export class UpdateCoordinator {
  private status: UpdateStatus = "idle";
  private available: UpdateManifest | null = null;
  private progress: UpdateProgress | null = null;
  private errorMessage: string | null = null;
  private blockReason: string | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: (url: string) => Promise<UpdateFetchResponse>;
  private activeCheck: Promise<UpdateSnapshot> | null = null;
  private activeDownload: Promise<UpdateSnapshot> | null = null;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl =
      options.fetchImpl ??
      (async (url: string) => {
        const response = await fetch(url);
        return {
          ok: response.ok,
          status: response.status,
          arrayBuffer: () => response.arrayBuffer(),
          text: () => response.text(),
          json: () => response.json()
        };
      });

    const state = options.stateStore.read();
    if (state.downloadedVersion) {
      this.status = "downloaded";
    }
  }

  getSnapshot(): UpdateSnapshot {
    return this.toSnapshot();
  }

  async checkForUpdates(): Promise<UpdateSnapshot> {
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.performCheck();
    try {
      return await this.activeCheck;
    } finally {
      this.activeCheck = null;
    }
  }

  async downloadUpdate(): Promise<UpdateSnapshot> {
    if (this.activeDownload) return this.activeDownload;
    this.activeDownload = this.performDownload();
    try {
      return await this.activeDownload;
    } finally {
      this.activeDownload = null;
    }
  }

  /**
   * Activate downloaded version as candidate. Sets requiresRestart=true.
   * Caller must restart runtime, waitForHealth, then markHealthy / failCandidate.
   */
  async applyDownloadedUpdate(): Promise<UpdateSnapshot> {
    const state = this.options.stateStore.read();
    const version = state.downloadedVersion?.trim();
    if (!version) {
      this.status = "failed";
      this.errorMessage = "No downloaded update is ready to apply.";
      return this.publish();
    }

    if (state.badVersions.includes(version)) {
      this.status = "blocked";
      this.blockReason = `version ${version} is marked bad`;
      this.errorMessage = this.blockReason;
      return this.publish();
    }

    if (!this.options.installStore.hasVersion(version)) {
      this.status = "failed";
      this.errorMessage = `downloaded version ${version} is not installed on disk`;
      return this.publish();
    }

    this.status = "applying";
    this.progress = { phase: "activate", detail: `activating ${version}` };
    this.publish();

    try {
      // Optional data migration before activation (workbench only).
      if (this.options.migration && this.available?.migrationVersion != null) {
        this.progress = { phase: "migrate", detail: `migrate → ${this.available.migrationVersion}` };
        this.publish();
        const result = await this.options.migration.migrate(
          state.appliedMigrationVersion,
          this.available.migrationVersion
        );
        if (!result.ok) {
          this.status = "failed";
          this.errorMessage = result.detail;
          this.progress = null;
          return this.publish();
        }
        await this.options.stateStore.update((s) => ({
          ...s,
          appliedMigrationVersion: result.toVersion
        }));
      }

      await this.options.lifecycle.activateVersion(version);
      this.available = null;
      this.status = "idle";
      this.progress = null;
      this.errorMessage = null;
      return this.publish("Candidate activated — restart required to health-gate the new version");
    } catch (error) {
      this.status = "failed";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.progress = null;
      return this.publish();
    }
  }

  async markCurrentHealthy(version: string): Promise<UpdateSnapshot> {
    await this.options.lifecycle.markVersionHealthy(version);
    this.status = "idle";
    this.errorMessage = null;
    return this.publish(`Version ${version} marked Last Known Good`);
  }

  async recoverCandidate(): Promise<UpdateSnapshot> {
    const result = await this.options.lifecycle.recoverPendingCandidate();
    if (!result) {
      return this.publish("No pending candidate rollback required");
    }
    this.status = "rolled-back";
    return this.publish(
      `Rolled back from ${result.rolledBackFrom} to ${result.rolledBackTo ?? "none"} (marked bad)`
    );
  }

  async failCandidate(version?: string): Promise<UpdateSnapshot> {
    const result = await this.options.lifecycle.failCandidate(version);
    this.status = "rolled-back";
    return this.publish(
      `Candidate ${result.rolledBackFrom} failed; restored ${result.rolledBackTo ?? "none"}`
    );
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async performCheck(): Promise<UpdateSnapshot> {
    const manifestUrl = this.options.manifestUrl?.trim();
    if (!manifestUrl) {
      this.status = "blocked";
      this.blockReason = "update manifest URL is not configured";
      this.errorMessage = this.blockReason;
      return this.publish();
    }

    this.status = "checking";
    this.errorMessage = null;
    this.blockReason = null;
    this.progress = null;
    this.publish();

    try {
      const response = await this.fetchImpl(manifestUrl);
      if (!response.ok) {
        throw new Error(`manifest HTTP ${response.status}`);
      }
      const raw = await response.json();
      const manifest = parseUpdateManifest(raw);
      verifyUpdateManifestSignature(manifest, this.options.verify);

      const platform = this.options.platform ?? process.platform;
      const arch = this.options.arch ?? process.arch;
      if (manifest.platform !== platform) {
        throw new Error(`manifest platform ${manifest.platform} does not match ${platform}`);
      }
      if (manifest.arch !== arch) {
        throw new Error(`manifest arch ${manifest.arch} does not match ${arch}`);
      }
      if (!isLauncherCompatible(this.options.launcherVersion, manifest.minimumLauncherVersion)) {
        this.status = "blocked";
        this.blockReason = `launcher ${this.options.launcherVersion} < minimum ${manifest.minimumLauncherVersion}`;
        this.errorMessage = this.blockReason;
        this.available = null;
        await this.touchCheckedAt();
        return this.publish();
      }

      const state = this.options.stateStore.read();
      if (state.badVersions.includes(manifest.latestVersion)) {
        this.status = "blocked";
        this.blockReason = `version ${manifest.latestVersion} is marked bad`;
        this.errorMessage = this.blockReason;
        this.available = null;
        await this.touchCheckedAt();
        return this.publish();
      }

      await this.touchCheckedAt();

      if (state.currentVersion && state.currentVersion === manifest.latestVersion) {
        this.available = null;
        this.status = "up-to-date";
        return this.publish("Already on latest version");
      }

      this.available = manifest;
      if (state.downloadedVersion === manifest.latestVersion && this.options.installStore.hasVersion(manifest.latestVersion)) {
        this.status = "downloaded";
        return this.publish(`Update ${manifest.latestVersion} already downloaded`);
      }

      this.status = "update-available";
      return this.publish(`Update available: ${manifest.latestVersion}`);
    } catch (error) {
      this.status = "failed";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.available = null;
      return this.publish();
    }
  }

  private async performDownload(): Promise<UpdateSnapshot> {
    if (!this.available) {
      const checked = await this.checkForUpdates();
      if (checked.status !== "update-available" && checked.status !== "downloaded") {
        return checked;
      }
    }
    const manifest = this.available;
    if (!manifest) {
      this.status = "failed";
      this.errorMessage = "No update available to download";
      return this.publish();
    }

    const state = this.options.stateStore.read();
    if (state.badVersions.includes(manifest.latestVersion)) {
      this.status = "blocked";
      this.blockReason = `version ${manifest.latestVersion} is marked bad`;
      this.errorMessage = this.blockReason;
      return this.publish();
    }

    this.status = "downloading";
    this.progress = { phase: "download", percent: 0, detail: manifest.bundleUrl };
    this.errorMessage = null;
    this.publish();

    try {
      const response = await this.fetchImpl(manifest.bundleUrl);
      if (!response.ok) {
        throw new Error(`bundle HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      this.progress = { phase: "verify", bytesTotal: bytes.length, percent: 100 };
      this.publish();

      verifyBundlePayload(bytes, manifest, this.options.verify);

      this.progress = { phase: "extract", detail: `install ${manifest.latestVersion}` };
      this.publish();
      await this.options.installStore.installVersion(manifest.latestVersion, bytes, manifest);

      await this.options.stateStore.update((s) => ({
        ...s,
        downloadedVersion: manifest.latestVersion,
        downloadedReleaseNotesUrl: manifest.releaseNotesUrl,
        lastUpdateCheckAt: new Date(this.now()).toISOString()
      }));

      this.status = "downloaded";
      this.progress = null;
      return this.publish(
        `Downloaded and verified ${manifest.latestVersion}. Apply will activate as candidate (restart required).`
      );
    } catch (error) {
      this.status = "failed";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.progress = null;
      return this.publish();
    }
  }

  private async touchCheckedAt(): Promise<void> {
    await this.options.stateStore.update((s) => ({
      ...s,
      lastUpdateCheckAt: new Date(this.now()).toISOString()
    }));
  }

  private toSnapshot(detail?: string): UpdateSnapshot {
    const state = this.options.stateStore.read();
    const availableVersion = this.available?.latestVersion ?? null;
    const canDownload =
      this.status === "update-available" ||
      (this.status === "failed" && Boolean(this.available));
    const canApply =
      Boolean(state.downloadedVersion) &&
      this.options.installStore.hasVersion(state.downloadedVersion!) &&
      !state.badVersions.includes(state.downloadedVersion!);

    const requiresRestart =
      Boolean(state.candidateVersion) ||
      this.status === "applying" ||
      (canApply && this.status === "downloaded");

    return {
      generatedAt: new Date(this.now()).toISOString(),
      status: this.status,
      channel: this.options.channel ?? state.channel,
      launcherVersion: this.options.launcherVersion,
      currentVersion: state.currentVersion,
      lastKnownGoodVersion: state.lastKnownGoodVersion,
      candidateVersion: state.candidateVersion,
      availableVersion,
      downloadedVersion: state.downloadedVersion,
      releaseNotesUrl: state.downloadedReleaseNotesUrl ?? this.available?.releaseNotesUrl ?? null,
      lastCheckedAt: state.lastUpdateCheckAt,
      progress: this.progress,
      canCheck: Boolean(this.options.manifestUrl?.trim()),
      canDownload: Boolean(canDownload && this.available),
      canApply,
      requiresRestart,
      badVersions: [...state.badVersions],
      blockReason: this.blockReason,
      errorMessage: this.errorMessage,
      detail:
        detail ??
        this.errorMessage ??
        this.blockReason ??
        (this.status === "up-to-date"
          ? "Already on latest version"
          : this.status === "update-available"
            ? `Update available: ${availableVersion}`
            : this.status === "downloaded"
              ? `Downloaded ${state.downloadedVersion}; apply requires restart`
              : this.status)
    };
  }

  private publish(detail?: string): UpdateSnapshot {
    const snapshot = this.toSnapshot(detail);
    this.options.onSnapshot?.(snapshot);
    return snapshot;
  }
}
