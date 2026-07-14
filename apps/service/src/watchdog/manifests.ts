/**
 * Parse + validate bundle and update manifests.
 */

import type { BundleManifest, UpdateManifest } from "./watchdogTypes.js";
import {
  assertSha256Match,
  normalizeHexHash,
  serializeUnsignedUpdateManifest,
  verifySignature,
  type VerifySignatureOptions
} from "./integrity.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} missing required string field: ${key}`);
  }
  return value.trim();
}

function readRequiredObject(record: Record<string, unknown>, key: string, context: string): Record<string, unknown> {
  const value = record[key];
  if (!isObject(value)) {
    throw new Error(`${context} missing required object field: ${key}`);
  }
  return value;
}

export function parseBundleManifest(input: unknown, context = "bundle manifest"): BundleManifest {
  if (!isObject(input)) {
    throw new Error(`${context} must be an object`);
  }
  const entrypoints = readRequiredObject(input, "entrypoints", context);
  const migrationVersion = Number(input.migrationVersion);
  if (!Number.isInteger(migrationVersion) || migrationVersion < 0) {
    throw new Error(`${context} has invalid migrationVersion`);
  }

  // Accept either nested launcherCompatibility.minVersion (NextClaw) or flat minLauncherVersion.
  let minLauncherVersion: string;
  if (typeof input.minLauncherVersion === "string" && input.minLauncherVersion.trim()) {
    minLauncherVersion = input.minLauncherVersion.trim();
  } else if (isObject(input.launcherCompatibility)) {
    minLauncherVersion = readRequiredString(
      input.launcherCompatibility,
      "minVersion",
      `${context}.launcherCompatibility`
    );
  } else {
    throw new Error(`${context} missing minLauncherVersion`);
  }

  const serviceEntry =
    typeof entrypoints.serviceEntry === "string" && entrypoints.serviceEntry.trim()
      ? entrypoints.serviceEntry.trim()
      : typeof entrypoints.runtimeScript === "string" && entrypoints.runtimeScript.trim()
        ? entrypoints.runtimeScript.trim()
        : null;
  if (!serviceEntry) {
    throw new Error(`${context}.entrypoints missing serviceEntry`);
  }

  const manifest: BundleManifest = {
    bundleVersion: readRequiredString(input, "bundleVersion", context),
    platform: readRequiredString(input, "platform", context),
    arch: readRequiredString(input, "arch", context),
    uiVersion: readRequiredString(input, "uiVersion", context),
    runtimeVersion: readRequiredString(input, "runtimeVersion", context),
    minLauncherVersion,
    migrationVersion,
    entrypoints: { serviceEntry }
  };

  if (typeof input.bundleSha256 === "string" && input.bundleSha256.trim()) {
    manifest.bundleSha256 = normalizeHexHash(input.bundleSha256);
  }
  return manifest;
}

export function parseUpdateManifest(input: unknown, context = "update manifest"): UpdateManifest {
  if (!isObject(input)) {
    throw new Error(`${context} must be an object`);
  }
  const releaseNotesUrl =
    typeof input.releaseNotesUrl === "string" && input.releaseNotesUrl.trim()
      ? input.releaseNotesUrl.trim()
      : null;

  const manifest: UpdateManifest = {
    channel: readRequiredString(input, "channel", context),
    platform: readRequiredString(input, "platform", context),
    arch: readRequiredString(input, "arch", context),
    latestVersion: readRequiredString(input, "latestVersion", context),
    minimumLauncherVersion: readRequiredString(input, "minimumLauncherVersion", context),
    bundleUrl: readRequiredString(input, "bundleUrl", context),
    bundleSha256: normalizeHexHash(readRequiredString(input, "bundleSha256", context)),
    bundleSignature: readRequiredString(input, "bundleSignature", context),
    manifestSignature: readRequiredString(input, "manifestSignature", context),
    releaseNotesUrl
  };

  if (input.migrationVersion !== undefined) {
    const migrationVersion = Number(input.migrationVersion);
    if (!Number.isInteger(migrationVersion) || migrationVersion < 0) {
      throw new Error(`${context} has invalid migrationVersion`);
    }
    manifest.migrationVersion = migrationVersion;
  }
  return manifest;
}

export function verifyUpdateManifestSignature(
  manifest: UpdateManifest,
  options: VerifySignatureOptions
): void {
  const canonical = serializeUnsignedUpdateManifest({
    channel: String(manifest.channel),
    platform: manifest.platform,
    arch: manifest.arch,
    latestVersion: manifest.latestVersion,
    minimumLauncherVersion: manifest.minimumLauncherVersion,
    bundleUrl: manifest.bundleUrl,
    bundleSha256: manifest.bundleSha256,
    bundleSignature: manifest.bundleSignature,
    releaseNotesUrl: manifest.releaseNotesUrl,
    migrationVersion: manifest.migrationVersion
  });
  verifySignature(canonical, manifest.manifestSignature, options);
}

export function verifyBundlePayload(
  bytes: Buffer,
  manifest: Pick<UpdateManifest, "bundleSha256" | "bundleSignature">,
  options: VerifySignatureOptions
): void {
  assertSha256Match(bytes, manifest.bundleSha256, "bundle archive");
  verifySignature(bytes, manifest.bundleSignature, options);
}

/**
 * Compare dotted numeric versions: returns -1 / 0 / 1.
 * Non-numeric segments compare lexicographically after numeric parts.
 */
export function compareSemverLike(a: string, b: string): number {
  const pa = a.trim().split(/[.+-]/u).filter(Boolean);
  const pb = b.trim().split(/[.+-]/u).filter(Boolean);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === sa && String(nb) === sb) {
      if (na < nb) return -1;
      if (na > nb) return 1;
      continue;
    }
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

export function isLauncherCompatible(launcherVersion: string, minimumLauncherVersion: string): boolean {
  return compareSemverLike(launcherVersion, minimumLauncherVersion) >= 0;
}
