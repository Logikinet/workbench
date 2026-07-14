/**
 * Plugin API + engine (core) compatibility checks (Task 46).
 */

import {
  PLUGIN_API_VERSION,
  type PluginCompatResult,
  type PluginEngineCompat,
  type PluginManifest
} from "./pluginTypes.js";

/** Compare dotted numeric versions (semver-like, prerelease ignored). */
export function compareSemverLike(left: string, right: string): number {
  const l = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const r = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0;
    const rv = r[i] ?? 0;
    if (lv !== rv) return lv < rv ? -1 : 1;
  }
  return 0;
}

/**
 * Major API family must match. "1" and "1.0" are treated as compatible;
 * "2" is not compatible with host "1".
 */
export function isApiVersionCompatible(
  pluginApiVersion: string,
  hostApiVersion: string = PLUGIN_API_VERSION
): boolean {
  const pluginMajor = Number.parseInt(pluginApiVersion.split(".")[0] ?? "", 10);
  const hostMajor = Number.parseInt(hostApiVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(pluginMajor) || !Number.isFinite(hostMajor)) {
    return false;
  }
  return pluginMajor === hostMajor;
}

export function isEngineCompatible(engine: PluginEngineCompat, coreVersion: string): boolean {
  if (compareSemverLike(coreVersion, engine.minCoreVersion) < 0) {
    return false;
  }
  if (engine.maxCoreVersion && compareSemverLike(coreVersion, engine.maxCoreVersion) >= 0) {
    return false;
  }
  return true;
}

export function checkPluginCompatibility(
  manifest: Pick<PluginManifest, "id" | "version" | "apiVersion" | "engine">,
  coreVersion: string,
  hostApiVersion: string = PLUGIN_API_VERSION
): PluginCompatResult {
  const reasons: string[] = [];
  const apiVersionOk = isApiVersionCompatible(manifest.apiVersion, hostApiVersion);
  if (!apiVersionOk) {
    reasons.push(
      `Plugin API ${manifest.apiVersion} is incompatible with host API ${hostApiVersion}.`
    );
  }
  const engineOk = isEngineCompatible(manifest.engine, coreVersion);
  if (!engineOk) {
    const range = manifest.engine.maxCoreVersion
      ? `[${manifest.engine.minCoreVersion}, ${manifest.engine.maxCoreVersion})`
      : `>= ${manifest.engine.minCoreVersion}`;
    reasons.push(
      `Core version ${coreVersion} is outside plugin engine range ${range}.`
    );
  }
  return {
    compatible: apiVersionOk && engineOk,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    coreVersion,
    apiVersionOk,
    engineOk,
    reasons
  };
}
