import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  serializeUnsignedUpdateManifest,
  sha256Hex,
  signEd25519,
  signHmacSha256
} from "./integrity.js";
import {
  compareSemverLike,
  isLauncherCompatible,
  parseBundleManifest,
  parseUpdateManifest,
  verifyBundlePayload,
  verifyUpdateManifestSignature
} from "./manifests.js";

describe("parseBundleManifest", () => {
  it("accepts flat minLauncherVersion and serviceEntry", () => {
    const m = parseBundleManifest({
      bundleVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      uiVersion: "1.0.0",
      runtimeVersion: "1.0.0",
      minLauncherVersion: "0.1.0",
      migrationVersion: 2,
      entrypoints: { serviceEntry: "service/dist/main.js" }
    });
    expect(m.migrationVersion).toBe(2);
    expect(m.entrypoints.serviceEntry).toBe("service/dist/main.js");
  });

  it("accepts NextClaw-shaped launcherCompatibility + runtimeScript", () => {
    const m = parseBundleManifest({
      bundleVersion: "0.18.0",
      platform: "win32",
      arch: "x64",
      uiVersion: "0.18.0",
      runtimeVersion: "0.18.0",
      builtInPluginSetVersion: "1",
      launcherCompatibility: { minVersion: "0.1.0" },
      entrypoints: { runtimeScript: "runtime/dist/cli.js" },
      migrationVersion: 0
    });
    expect(m.minLauncherVersion).toBe("0.1.0");
    expect(m.entrypoints.serviceEntry).toBe("runtime/dist/cli.js");
  });

  it("rejects invalid migrationVersion", () => {
    expect(() =>
      parseBundleManifest({
        bundleVersion: "1",
        platform: "win32",
        arch: "x64",
        uiVersion: "1",
        runtimeVersion: "1",
        minLauncherVersion: "0",
        migrationVersion: 1.5,
        entrypoints: { serviceEntry: "x" }
      })
    ).toThrow(/migrationVersion/);
  });
});

describe("update manifest integrity", () => {
  it("verifies ed25519 manifest + bundle signatures", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const bytes = Buffer.from("bundle-bytes");
    const bundleSha256 = sha256Hex(bytes);
    const bundleSignature = signEd25519(bytes, privatePem);
    const unsigned = serializeUnsignedUpdateManifest({
      channel: "stable",
      platform: "win32",
      arch: "x64",
      latestVersion: "1.2.0",
      minimumLauncherVersion: "0.1.0",
      bundleUrl: "https://example.com/b",
      bundleSha256,
      bundleSignature,
      releaseNotesUrl: null
    });
    const manifestSignature = signEd25519(unsigned, privatePem);
    const manifest = parseUpdateManifest({
      channel: "stable",
      platform: "win32",
      arch: "x64",
      latestVersion: "1.2.0",
      minimumLauncherVersion: "0.1.0",
      bundleUrl: "https://example.com/b",
      bundleSha256,
      bundleSignature,
      releaseNotesUrl: null,
      manifestSignature
    });
    verifyUpdateManifestSignature(manifest, { publicKeyPem: publicPem });
    verifyBundlePayload(bytes, manifest, { publicKeyPem: publicPem });
  });

  it("supports hmac-sha256 for air-gapped tests", () => {
    const secret = "test-secret";
    const bytes = Buffer.from("hmac-bundle");
    const bundleSha256 = sha256Hex(bytes);
    const bundleSignature = signHmacSha256(bytes, secret);
    const unsigned = serializeUnsignedUpdateManifest({
      channel: "stable",
      platform: "win32",
      arch: "x64",
      latestVersion: "1.0.0",
      minimumLauncherVersion: "0.1.0",
      bundleUrl: "https://example.com/b",
      bundleSha256,
      bundleSignature,
      releaseNotesUrl: null
    });
    const manifestSignature = signHmacSha256(unsigned, secret);
    const manifest = parseUpdateManifest({
      channel: "stable",
      platform: "win32",
      arch: "x64",
      latestVersion: "1.0.0",
      minimumLauncherVersion: "0.1.0",
      bundleUrl: "https://example.com/b",
      bundleSha256,
      bundleSignature,
      manifestSignature,
      releaseNotesUrl: null
    });
    verifyUpdateManifestSignature(manifest, { algorithm: "hmac-sha256", hmacSecret: secret });
    verifyBundlePayload(bytes, manifest, { algorithm: "hmac-sha256", hmacSecret: secret });
  });
});

describe("compareSemverLike", () => {
  it("orders versions", () => {
    expect(compareSemverLike("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemverLike("1.2.0", "1.2.0")).toBe(0);
    expect(compareSemverLike("2.0.0", "1.9.9")).toBe(1);
    expect(isLauncherCompatible("0.2.0", "0.1.0")).toBe(true);
    expect(isLauncherCompatible("0.1.0", "0.2.0")).toBe(false);
  });
});
