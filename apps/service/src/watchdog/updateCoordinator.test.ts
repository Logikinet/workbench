import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  serializeUnsignedUpdateManifest,
  sha256Hex,
  signEd25519
} from "./integrity.js";
import { LauncherStateStore, type LauncherStateFs } from "./launcherState.js";
import { BundleLifecycleService, type BundleLayout } from "./bundleLifecycle.js";
import { UpdateCoordinator, type BundleInstallStore, type UpdateFetchResponse } from "./updateCoordinator.js";
import { DEFAULT_LAUNCHER_STATE, type UpdateManifest } from "./watchdogTypes.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function memoryStateFs(initial?: string): LauncherStateFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial) files.set("/state.json", initial);
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    mkdir: async () => undefined,
    writeFile: async (p, d) => {
      files.set(p, d);
    }
  };
}

function layoutFor(versions: Set<string>): BundleLayout {
  return {
    resolveVersion(version) {
      if (!versions.has(version)) throw new Error(`missing ${version}`);
      return { version, directory: `/v/${version}` };
    },
    async writeCurrentPointer() {},
    async writePreviousPointer() {},
    async clearPreviousPointer() {},
    async clearCurrentPointer() {}
  };
}

function signedManifest(over: Partial<UpdateManifest> & { bundleBytes: Buffer }): UpdateManifest {
  const bundleSha256 = sha256Hex(over.bundleBytes);
  const bundleSignature = signEd25519(over.bundleBytes, privatePem);
  const unsigned = {
    channel: over.channel ?? "stable",
    platform: over.platform ?? "win32",
    arch: over.arch ?? "x64",
    latestVersion: over.latestVersion ?? "1.1.0",
    minimumLauncherVersion: over.minimumLauncherVersion ?? "0.1.0",
    bundleUrl: over.bundleUrl ?? "https://example.com/bundle.bin",
    bundleSha256,
    bundleSignature,
    releaseNotesUrl: over.releaseNotesUrl ?? null,
    migrationVersion: over.migrationVersion
  };
  const canonical = serializeUnsignedUpdateManifest(unsigned);
  const manifestSignature = signEd25519(canonical, privatePem);
  return { ...unsigned, manifestSignature };
}

function jsonResponse(body: unknown): UpdateFetchResponse {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      const buf = Buffer.from(JSON.stringify(body));
      return Uint8Array.from(buf).buffer as ArrayBuffer;
    },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    }
  };
}

function bytesResponse(bytes: Buffer): UpdateFetchResponse {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer as ArrayBuffer;
    },
    async text() {
      return bytes.toString("utf8");
    },
    async json() {
      return JSON.parse(bytes.toString("utf8"));
    }
  };
}

describe("UpdateCoordinator", () => {
  it("checks signed manifest, downloads with integrity, applies as candidate requiring restart", async () => {
    const bundleBytes = Buffer.from("PAW-BUNDLE-1.1.0");
    const manifest = signedManifest({
      latestVersion: "1.1.0",
      platform: "win32",
      arch: "x64",
      bundleBytes
    });

    const fs = memoryStateFs(
      JSON.stringify({
        ...DEFAULT_LAUNCHER_STATE,
        currentVersion: "1.0.0",
        lastKnownGoodVersion: "1.0.0"
      })
    );
    const store = new LauncherStateStore("/state.json", fs);
    const versions = new Set(["1.0.0"]);
    const lifecycle = new BundleLifecycleService(store, layoutFor(versions));
    const installStore: BundleInstallStore = {
      hasVersion: (v) => versions.has(v),
      async installVersion(version) {
        versions.add(version);
        return { directory: `/v/${version}` };
      }
    };

    const coordinator = new UpdateCoordinator({
      launcherVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      stateStore: store,
      lifecycle,
      installStore,
      verify: { publicKeyPem: publicPem, algorithm: "ed25519" },
      manifestUrl: "https://example.com/manifest.json",
      fetchImpl: async (url) => {
        if (url.includes("manifest")) return jsonResponse(manifest);
        return bytesResponse(bundleBytes);
      },
      now: () => 1_700_000_000_000
    });

    const checked = await coordinator.checkForUpdates();
    expect(checked.status).toBe("update-available");
    expect(checked.availableVersion).toBe("1.1.0");
    expect(checked.canDownload).toBe(true);

    const downloaded = await coordinator.downloadUpdate();
    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(downloaded.requiresRestart).toBe(true);
    expect(downloaded.canApply).toBe(true);
    expect(downloaded.detail).toMatch(/restart/i);

    const applied = await coordinator.applyDownloadedUpdate();
    expect(applied.candidateVersion).toBe("1.1.0");
    expect(applied.requiresRestart).toBe(true);
    expect(applied.currentVersion).toBe("1.1.0");
    expect(applied.lastKnownGoodVersion).toBe("1.0.0");

    const healthy = await coordinator.markCurrentHealthy("1.1.0");
    expect(healthy.lastKnownGoodVersion).toBe("1.1.0");
    expect(healthy.candidateVersion).toBeNull();
  });

  it("rejects tampered bundle sha256", async () => {
    const bundleBytes = Buffer.from("good-bytes");
    const manifest = signedManifest({ latestVersion: "2.0.0", platform: "win32", arch: "x64", bundleBytes });
    // Tamper hash after signing
    manifest.bundleSha256 = sha256Hex(Buffer.from("other"));

    const fs = memoryStateFs(JSON.stringify({ ...DEFAULT_LAUNCHER_STATE, currentVersion: "1.0.0" }));
    const store = new LauncherStateStore("/state.json", fs);
    const versions = new Set(["1.0.0"]);
    const coordinator = new UpdateCoordinator({
      launcherVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      stateStore: store,
      lifecycle: new BundleLifecycleService(store, layoutFor(versions)),
      installStore: {
        hasVersion: (v) => versions.has(v),
        async installVersion(version) {
          versions.add(version);
          return { directory: `/v/${version}` };
        }
      },
      verify: { publicKeyPem: publicPem },
      manifestUrl: "https://example.com/manifest.json",
      fetchImpl: async (url) => {
        if (url.includes("manifest")) return jsonResponse(manifest);
        return bytesResponse(bundleBytes);
      }
    });

    // Manifest signature covers bundleSha256, so check should fail on verify
    const checked = await coordinator.checkForUpdates();
    expect(checked.status).toBe("failed");
    expect(checked.errorMessage).toMatch(/signature verification failed/i);
  });

  it("blocks bad versions from download/apply", async () => {
    const bundleBytes = Buffer.from("x");
    const manifest = signedManifest({
      latestVersion: "3.0.0",
      platform: "win32",
      arch: "x64",
      bundleBytes
    });
    const fs = memoryStateFs(
      JSON.stringify({
        ...DEFAULT_LAUNCHER_STATE,
        currentVersion: "1.0.0",
        lastKnownGoodVersion: "1.0.0",
        badVersions: ["3.0.0"]
      })
    );
    const store = new LauncherStateStore("/state.json", fs);
    const versions = new Set(["1.0.0"]);
    const coordinator = new UpdateCoordinator({
      launcherVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      stateStore: store,
      lifecycle: new BundleLifecycleService(store, layoutFor(versions)),
      installStore: {
        hasVersion: (v) => versions.has(v),
        async installVersion() {
          throw new Error("should not install");
        }
      },
      verify: { publicKeyPem: publicPem },
      manifestUrl: "https://example.com/manifest.json",
      fetchImpl: async () => jsonResponse(manifest)
    });

    const checked = await coordinator.checkForUpdates();
    expect(checked.status).toBe("blocked");
    expect(checked.blockReason).toMatch(/marked bad/);
  });

  it("reports up-to-date when current matches latest", async () => {
    const bundleBytes = Buffer.from("same");
    const manifest = signedManifest({
      latestVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      bundleBytes
    });
    const fs = memoryStateFs(
      JSON.stringify({
        ...DEFAULT_LAUNCHER_STATE,
        currentVersion: "1.0.0",
        lastKnownGoodVersion: "1.0.0"
      })
    );
    const store = new LauncherStateStore("/state.json", fs);
    const coordinator = new UpdateCoordinator({
      launcherVersion: "0.1.0",
      platform: "win32",
      arch: "x64",
      stateStore: store,
      lifecycle: new BundleLifecycleService(store, layoutFor(new Set(["1.0.0"]))),
      installStore: {
        hasVersion: () => true,
        async installVersion() {
          return { directory: "/v" };
        }
      },
      verify: { publicKeyPem: publicPem },
      manifestUrl: "https://example.com/manifest.json",
      fetchImpl: async () => jsonResponse(manifest)
    });

    const checked = await coordinator.checkForUpdates();
    expect(checked.status).toBe("up-to-date");
  });

  it("failCandidate after failed health rolls back and marks bad", async () => {
    const fs = memoryStateFs(
      JSON.stringify({
        ...DEFAULT_LAUNCHER_STATE,
        currentVersion: "1.0.0",
        lastKnownGoodVersion: "1.0.0"
      })
    );
    const store = new LauncherStateStore("/state.json", fs);
    const versions = new Set(["1.0.0", "1.5.0"]);
    const lifecycle = new BundleLifecycleService(store, layoutFor(versions));
    await lifecycle.activateVersion("1.5.0");

    const coordinator = new UpdateCoordinator({
      launcherVersion: "0.1.0",
      stateStore: store,
      lifecycle,
      installStore: {
        hasVersion: (v) => versions.has(v),
        async installVersion() {
          return { directory: "/v" };
        }
      },
      verify: { publicKeyPem: publicPem }
    });

    const rolled = await coordinator.failCandidate();
    expect(rolled.status).toBe("rolled-back");
    expect(store.read().currentVersion).toBe("1.0.0");
    expect(store.read().badVersions).toContain("1.5.0");
  });
});
