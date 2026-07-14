/**
 * Facade combining runtime recovery + update/LKG lifecycle for routes.
 */

import type { BundleLifecycleService } from "./bundleLifecycle.js";
import type { RuntimeWatchdog } from "./runtimeWatchdog.js";
import type { UpdateCoordinator } from "./updateCoordinator.js";
import {
  WATCHDOG_OPERATION_CONTRACT,
  type UpdateSnapshot,
  type WatchdogOperationContract,
  type WatchdogRuntimeSnapshot
} from "./watchdogTypes.js";

export interface WatchdogServiceOptions {
  runtime: RuntimeWatchdog;
  updates?: UpdateCoordinator;
  lifecycle?: BundleLifecycleService;
}

export class WatchdogService {
  constructor(private readonly options: WatchdogServiceOptions) {}

  contract(): WatchdogOperationContract {
    return WATCHDOG_OPERATION_CONTRACT;
  }

  async runtimeStatus(): Promise<WatchdogRuntimeSnapshot> {
    return this.options.runtime.status();
  }

  runtimeSnapshot(): WatchdogRuntimeSnapshot {
    return this.options.runtime.getSnapshot();
  }

  stopRecovery(): WatchdogRuntimeSnapshot {
    return this.options.runtime.stopRecovery();
  }

  resetRecovery(): WatchdogRuntimeSnapshot {
    return this.options.runtime.resetRecovery();
  }

  updateSnapshot(): UpdateSnapshot {
    if (!this.options.updates) {
      return emptyUpdateSnapshot("Update coordinator is not configured");
    }
    return this.options.updates.getSnapshot();
  }

  async checkForUpdates(): Promise<UpdateSnapshot> {
    return this.requireUpdates().checkForUpdates();
  }

  async downloadUpdate(): Promise<UpdateSnapshot> {
    return this.requireUpdates().downloadUpdate();
  }

  async applyUpdate(): Promise<UpdateSnapshot> {
    return this.requireUpdates().applyDownloadedUpdate();
  }

  async markHealthy(version: string): Promise<UpdateSnapshot> {
    if (this.options.updates) {
      return this.options.updates.markCurrentHealthy(version);
    }
    const lifecycle = this.requireLifecycle();
    await lifecycle.markVersionHealthy(version);
    return emptyUpdateSnapshot(`Version ${version} marked Last Known Good`);
  }

  async recoverCandidate(): Promise<UpdateSnapshot> {
    if (this.options.updates) {
      return this.options.updates.recoverCandidate();
    }
    const lifecycle = this.requireLifecycle();
    const result = await lifecycle.recoverPendingCandidate();
    if (!result) return emptyUpdateSnapshot("No pending candidate rollback required");
    return emptyUpdateSnapshot(
      `Rolled back from ${result.rolledBackFrom} to ${result.rolledBackTo ?? "none"}`
    );
  }

  async failCandidate(version?: string): Promise<UpdateSnapshot> {
    if (this.options.updates) {
      return this.options.updates.failCandidate(version);
    }
    const lifecycle = this.requireLifecycle();
    const result = await lifecycle.failCandidate(version);
    return emptyUpdateSnapshot(
      `Candidate ${result.rolledBackFrom} failed; restored ${result.rolledBackTo ?? "none"}`
    );
  }

  private requireUpdates(): UpdateCoordinator {
    if (!this.options.updates) {
      throw new Error("Update coordinator is not configured");
    }
    return this.options.updates;
  }

  private requireLifecycle(): BundleLifecycleService {
    if (!this.options.lifecycle) {
      throw new Error("Bundle lifecycle is not configured");
    }
    return this.options.lifecycle;
  }
}

function emptyUpdateSnapshot(detail: string): UpdateSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    status: "blocked",
    channel: "stable",
    launcherVersion: "0",
    currentVersion: null,
    lastKnownGoodVersion: null,
    candidateVersion: null,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotesUrl: null,
    lastCheckedAt: null,
    progress: null,
    canCheck: false,
    canDownload: false,
    canApply: false,
    requiresRestart: false,
    badVersions: [],
    blockReason: detail,
    errorMessage: null,
    detail
  };
}
