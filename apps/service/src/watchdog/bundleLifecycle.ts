/**
 * Candidate → Last Known Good bundle lifecycle (NextClaw-inspired).
 *
 * New versions activate as candidates; only markHealthy after health gate.
 * Failed candidates roll back to previous/LKG and are added to badVersions.
 */

import type {
  BundleActivationResult,
  BundleHealthyResult,
  BundleRollbackResult,
  LauncherState
} from "./watchdogTypes.js";
import type { LauncherStateStore } from "./launcherState.js";

export interface BundleLayout {
  /** Ensure versioned install exists / is readable. Throws if missing. */
  resolveVersion(version: string): { version: string; directory: string };
  writeCurrentPointer(version: string): Promise<void>;
  writePreviousPointer(version: string): Promise<void>;
  clearPreviousPointer(): Promise<void>;
  clearCurrentPointer(): Promise<void>;
  removeVersion?(version: string): Promise<void>;
}

export class BundleLifecycleService {
  constructor(
    private readonly stateStore: LauncherStateStore,
    private readonly layout: BundleLayout
  ) {}

  /**
   * Activate a downloaded version as the current candidate.
   * Does NOT mark LKG — caller must markHealthy after waitForHealth succeeds.
   */
  async activateVersion(version: string): Promise<BundleActivationResult> {
    const trimmed = version.trim();
    if (!trimmed) throw new Error("version is required");

    const state = this.stateStore.read();
    if (state.badVersions.includes(trimmed)) {
      throw new Error(`version ${trimmed} is marked bad and cannot be activated`);
    }

    this.layout.resolveVersion(trimmed);
    const previousVersion =
      state.currentVersion && state.currentVersion !== trimmed ? state.currentVersion : null;

    await this.layout.writeCurrentPointer(trimmed);
    if (previousVersion) {
      await this.layout.writePreviousPointer(previousVersion);
    } else {
      await this.layout.clearPreviousPointer();
    }

    await this.stateStore.write({
      ...state,
      currentVersion: trimmed,
      previousVersion,
      candidateVersion: trimmed,
      candidateLaunchCount: 0,
      downloadedVersion: state.downloadedVersion === trimmed ? null : state.downloadedVersion,
      downloadedReleaseNotesUrl:
        state.downloadedVersion === trimmed ? null : state.downloadedReleaseNotesUrl
    });

    return {
      activatedVersion: trimmed,
      previousVersion,
      role: "candidate"
    };
  }

  /**
   * On launcher boot: if a candidate never became healthy, roll it back.
   * First launch of a fresh candidate increments launch count and allows the attempt.
   */
  async recoverPendingCandidate(): Promise<BundleRollbackResult | null> {
    const state = this.stateStore.read();
    if (!state.candidateVersion) {
      return null;
    }

    // First boot after activation: allow the candidate one health-gated attempt.
    if (state.currentVersion === state.candidateVersion && state.candidateLaunchCount === 0) {
      await this.stateStore.update((current) => {
        if (!current.candidateVersion) return current;
        return {
          ...current,
          candidateLaunchCount: current.candidateLaunchCount + 1
        };
      });
      return null;
    }

    return this.rollbackCandidate(state);
  }

  /**
   * Explicit rollback after failed health gate on candidate.
   */
  async failCandidate(candidateVersion?: string): Promise<BundleRollbackResult> {
    const state = this.stateStore.read();
    const version = candidateVersion?.trim() || state.candidateVersion || state.currentVersion;
    if (!version) {
      throw new Error("no candidate version to fail");
    }
    return this.rollbackCandidate({
      ...state,
      candidateVersion: version
    });
  }

  /**
   * Promote current version to Last Known Good after health gate passes.
   */
  async markVersionHealthy(version: string): Promise<BundleHealthyResult> {
    const trimmed = version.trim();
    const next = await this.stateStore.update((state) => {
      if (state.currentVersion !== trimmed) {
        throw new Error(
          `cannot mark ${trimmed} healthy because currentVersion is ${state.currentVersion ?? "null"}`
        );
      }
      if (state.candidateVersion && state.candidateVersion !== trimmed) {
        throw new Error(
          `cannot mark ${trimmed} healthy because pending candidate is ${state.candidateVersion}`
        );
      }
      return {
        ...state,
        candidateVersion: null,
        candidateLaunchCount: 0,
        lastKnownGoodVersion: trimmed,
        badVersions: state.badVersions.filter((entry) => entry !== trimmed)
      };
    });

    return {
      version: trimmed,
      lastKnownGoodVersion: next.lastKnownGoodVersion!
    };
  }

  getState(): LauncherState {
    return this.stateStore.read();
  }

  private async rollbackCandidate(state: LauncherState): Promise<BundleRollbackResult> {
    const candidateVersion = state.candidateVersion;
    if (!candidateVersion) {
      throw new Error("no candidate to roll back");
    }

    const rollbackVersion = resolveRollbackVersion(
      state.previousVersion,
      state.lastKnownGoodVersion,
      candidateVersion
    );

    const badVersions = [...new Set([...state.badVersions, candidateVersion])];

    if (!rollbackVersion) {
      await this.layout.clearCurrentPointer();
      await this.layout.clearPreviousPointer();
      await this.stateStore.write({
        ...state,
        currentVersion: null,
        previousVersion: null,
        candidateVersion: null,
        candidateLaunchCount: 0,
        badVersions,
        downloadedVersion: null,
        downloadedReleaseNotesUrl: null
      });
      if (this.layout.removeVersion) {
        await this.layout.removeVersion(candidateVersion).catch(() => undefined);
      }
      return {
        rolledBackFrom: candidateVersion,
        rolledBackTo: null,
        markedBad: true
      };
    }

    this.layout.resolveVersion(rollbackVersion);
    await this.layout.writeCurrentPointer(rollbackVersion);
    await this.layout.clearPreviousPointer();
    await this.stateStore.write({
      ...state,
      currentVersion: rollbackVersion,
      previousVersion: null,
      candidateVersion: null,
      candidateLaunchCount: 0,
      lastKnownGoodVersion: rollbackVersion,
      badVersions,
      downloadedVersion: null,
      downloadedReleaseNotesUrl: null
    });
    if (this.layout.removeVersion) {
      await this.layout.removeVersion(candidateVersion).catch(() => undefined);
    }

    return {
      rolledBackFrom: candidateVersion,
      rolledBackTo: rollbackVersion,
      markedBad: true
    };
  }
}

export function resolveRollbackVersion(
  previousVersion: string | null,
  lastKnownGoodVersion: string | null,
  candidateVersion: string
): string | null {
  for (const version of [previousVersion, lastKnownGoodVersion]) {
    if (version && version !== candidateVersion) {
      return version;
    }
  }
  return null;
}
