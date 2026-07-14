import { describe, expect, it } from "vitest";
import { BundleLifecycleService, type BundleLayout } from "./bundleLifecycle.js";
import { LauncherStateStore, type LauncherStateFs } from "./launcherState.js";
import { DEFAULT_LAUNCHER_STATE } from "./watchdogTypes.js";

function memoryStateFs(): LauncherStateFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    mkdir: async () => undefined,
    writeFile: async (path, data) => {
      files.set(path, data);
    }
  };
}

function memoryLayout(versions: Set<string>): BundleLayout & {
  current: string | null;
  previous: string | null;
  removed: string[];
} {
  const state = {
    current: null as string | null,
    previous: null as string | null,
    removed: [] as string[]
  };
  return {
    get current() {
      return state.current;
    },
    get previous() {
      return state.previous;
    },
    get removed() {
      return state.removed;
    },
    resolveVersion(version) {
      if (!versions.has(version)) throw new Error(`bundle not found: ${version}`);
      return { version, directory: `/versions/${version}` };
    },
    async writeCurrentPointer(version) {
      state.current = version;
    },
    async writePreviousPointer(version) {
      state.previous = version;
    },
    async clearPreviousPointer() {
      state.previous = null;
    },
    async clearCurrentPointer() {
      state.current = null;
    },
    async removeVersion(version) {
      state.removed.push(version);
      versions.delete(version);
    }
  };
}

describe("BundleLifecycleService LKG", () => {
  it("activates version as candidate without LKG", async () => {
    const fs = memoryStateFs();
    const store = new LauncherStateStore("/state.json", fs);
    await store.write({
      ...DEFAULT_LAUNCHER_STATE,
      currentVersion: "1.0.0",
      lastKnownGoodVersion: "1.0.0"
    });
    const versions = new Set(["1.0.0", "1.1.0"]);
    const layout = memoryLayout(versions);
    const lifecycle = new BundleLifecycleService(store, layout);

    const result = await lifecycle.activateVersion("1.1.0");
    expect(result).toEqual({
      activatedVersion: "1.1.0",
      previousVersion: "1.0.0",
      role: "candidate"
    });
    expect(layout.current).toBe("1.1.0");
    expect(layout.previous).toBe("1.0.0");
    const state = store.read();
    expect(state.candidateVersion).toBe("1.1.0");
    expect(state.lastKnownGoodVersion).toBe("1.0.0");
    expect(state.candidateLaunchCount).toBe(0);
  });

  it("markVersionHealthy promotes candidate to LKG", async () => {
    const fs = memoryStateFs();
    const store = new LauncherStateStore("/state.json", fs);
    const versions = new Set(["1.1.0"]);
    const layout = memoryLayout(versions);
    const lifecycle = new BundleLifecycleService(store, layout);

    await lifecycle.activateVersion("1.1.0");
    const healthy = await lifecycle.markVersionHealthy("1.1.0");
    expect(healthy.lastKnownGoodVersion).toBe("1.1.0");
    const state = store.read();
    expect(state.candidateVersion).toBeNull();
    expect(state.lastKnownGoodVersion).toBe("1.1.0");
  });

  it("recoverPendingCandidate allows first launch then rolls back on second", async () => {
    const fs = memoryStateFs();
    const store = new LauncherStateStore("/state.json", fs);
    await store.write({
      ...DEFAULT_LAUNCHER_STATE,
      currentVersion: "1.0.0",
      lastKnownGoodVersion: "1.0.0"
    });
    const versions = new Set(["1.0.0", "1.2.0"]);
    const layout = memoryLayout(versions);
    const lifecycle = new BundleLifecycleService(store, layout);

    await lifecycle.activateVersion("1.2.0");
    const first = await lifecycle.recoverPendingCandidate();
    expect(first).toBeNull();
    expect(store.read().candidateLaunchCount).toBe(1);

    const second = await lifecycle.recoverPendingCandidate();
    expect(second).toEqual({
      rolledBackFrom: "1.2.0",
      rolledBackTo: "1.0.0",
      markedBad: true
    });
    expect(store.read().currentVersion).toBe("1.0.0");
    expect(store.read().candidateVersion).toBeNull();
    expect(store.read().badVersions).toContain("1.2.0");
    expect(layout.removed).toContain("1.2.0");
  });

  it("failCandidate marks bad and restores LKG", async () => {
    const fs = memoryStateFs();
    const store = new LauncherStateStore("/state.json", fs);
    await store.write({
      ...DEFAULT_LAUNCHER_STATE,
      currentVersion: "1.0.0",
      lastKnownGoodVersion: "1.0.0"
    });
    const versions = new Set(["1.0.0", "2.0.0"]);
    const layout = memoryLayout(versions);
    const lifecycle = new BundleLifecycleService(store, layout);
    await lifecycle.activateVersion("2.0.0");

    const result = await lifecycle.failCandidate("2.0.0");
    expect(result.rolledBackTo).toBe("1.0.0");
    expect(store.read().badVersions).toContain("2.0.0");
  });

  it("refuses to activate bad versions", async () => {
    const fs = memoryStateFs();
    const store = new LauncherStateStore("/state.json", fs);
    await store.write({
      ...DEFAULT_LAUNCHER_STATE,
      badVersions: ["9.9.9"]
    });
    const lifecycle = new BundleLifecycleService(store, memoryLayout(new Set(["9.9.9"])));
    await expect(lifecycle.activateVersion("9.9.9")).rejects.toThrow(/marked bad/);
  });
});
