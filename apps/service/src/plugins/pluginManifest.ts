/**
 * Plugin manifest parse / validate (Task 46).
 * File: paw.plugin.json (NextClaw-inspired nextclaw.extension.json shape).
 */

import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizePermissions } from "./pluginPermissions.js";
import {
  PLUGIN_MANIFEST_FILE,
  type ArtifactRendererContribution,
  type HarnessContribution,
  type PluginContributes,
  type PluginEntryType,
  type PluginJsonSchema,
  type PluginManifest,
  type PluginPermission,
  type PluginServerConfig,
  type PluginTriggerKind,
  type ProviderContribution,
  type ResolvedPluginManifest,
  type SkillSourceContribution,
  type ToolContribution,
  type TriggerContribution
} from "./pluginTypes.js";

export class PluginManifestError extends Error {
  readonly code = "plugin_manifest_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

function readString(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (required) {
    throw new PluginManifestError(`Manifest field "${field}" is required.`);
  }
  return undefined;
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new PluginManifestError(`Manifest field "${field}" must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginManifestError(`Manifest field "${field}" must be an object of strings.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new PluginManifestError(`Manifest field "${field}.${key}" must be a string.`);
    }
    out[key] = item;
  }
  return out;
}

function readEntry(value: unknown): PluginServerConfig {
  const record = readRecord(value);
  const type = readString(record.type, "entry.type") as PluginEntryType;
  if (type !== "stdio" && type !== "inprocess") {
    throw new PluginManifestError('Manifest entry.type must be "stdio" or "inprocess".');
  }
  const main = readString(record.main, "entry.main")!;
  const command = readString(record.command, "entry.command", false);
  const args =
    record.args === undefined
      ? undefined
      : Array.isArray(record.args) && record.args.every((a) => typeof a === "string")
        ? (record.args as string[])
        : (() => {
            throw new PluginManifestError("Manifest entry.args must be a string array.");
          })();
  const env = readStringRecord(record.env, "entry.env");
  return {
    type,
    main,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {})
  };
}

function readEngine(value: unknown): PluginManifest["engine"] {
  const record = readRecord(value);
  const minCoreVersion = readString(record.minCoreVersion, "engine.minCoreVersion")!;
  const maxCoreVersion = readString(record.maxCoreVersion, "engine.maxCoreVersion", false);
  return {
    minCoreVersion,
    ...(maxCoreVersion ? { maxCoreVersion } : {})
  };
}

function readTool(value: unknown, index: number): ToolContribution {
  const record = readRecord(value);
  const id = readString(record.id, `contributes.tools[${index}].id`)!;
  const name = readString(record.name, `contributes.tools[${index}].name`)!;
  const category = readString(record.category, `contributes.tools[${index}].category`)!;
  const allowed = ["readonly", "write", "shell", "network", "dangerous"];
  if (!allowed.includes(category)) {
    throw new PluginManifestError(
      `contributes.tools[${index}].category must be one of ${allowed.join(", ")}.`
    );
  }
  return {
    id,
    name,
    category: category as ToolContribution["category"],
    description: readString(record.description, `contributes.tools[${index}].description`, false),
    ...(record.inputSchema && typeof record.inputSchema === "object" && !Array.isArray(record.inputSchema)
      ? { inputSchema: record.inputSchema as PluginJsonSchema }
      : {})
  };
}

function readProvider(value: unknown, index: number): ProviderContribution {
  const record = readRecord(value);
  return {
    id: readString(record.id, `contributes.providers[${index}].id`)!,
    name: readString(record.name, `contributes.providers[${index}].name`)!,
    description: readString(record.description, `contributes.providers[${index}].description`, false),
    providerKind: readString(record.providerKind, `contributes.providers[${index}].providerKind`, false)
  };
}

function readHarness(value: unknown, index: number): HarnessContribution {
  const record = readRecord(value);
  return {
    id: readString(record.id, `contributes.harnesses[${index}].id`)!,
    name: readString(record.name, `contributes.harnesses[${index}].name`)!,
    description: readString(record.description, `contributes.harnesses[${index}].description`, false),
    capabilities:
      record.capabilities === undefined
        ? undefined
        : readStringArray(record.capabilities, `contributes.harnesses[${index}].capabilities`)
  };
}

function readSkillSource(value: unknown, index: number): SkillSourceContribution {
  const record = readRecord(value);
  return {
    id: readString(record.id, `contributes.skillSources[${index}].id`)!,
    name: readString(record.name, `contributes.skillSources[${index}].name`)!,
    description: readString(
      record.description,
      `contributes.skillSources[${index}].description`,
      false
    ),
    rootHint: readString(record.rootHint, `contributes.skillSources[${index}].rootHint`, false)
  };
}

function readArtifactRenderer(value: unknown, index: number): ArtifactRendererContribution {
  const record = readRecord(value);
  const mimeTypes = readStringArray(
    record.mimeTypes,
    `contributes.artifactRenderers[${index}].mimeTypes`
  );
  if (mimeTypes.length === 0) {
    throw new PluginManifestError(
      `contributes.artifactRenderers[${index}].mimeTypes must include at least one type.`
    );
  }
  return {
    id: readString(record.id, `contributes.artifactRenderers[${index}].id`)!,
    name: readString(record.name, `contributes.artifactRenderers[${index}].name`)!,
    description: readString(
      record.description,
      `contributes.artifactRenderers[${index}].description`,
      false
    ),
    mimeTypes,
    extensions:
      record.extensions === undefined
        ? undefined
        : readStringArray(record.extensions, `contributes.artifactRenderers[${index}].extensions`)
  };
}

function readTrigger(value: unknown, index: number): TriggerContribution {
  const record = readRecord(value);
  const kind = readString(record.kind, `contributes.triggers[${index}].kind`)!;
  if (kind !== "cron" && kind !== "webhook" && kind !== "event") {
    throw new PluginManifestError(
      `contributes.triggers[${index}].kind must be cron, webhook, or event.`
    );
  }
  return {
    id: readString(record.id, `contributes.triggers[${index}].id`)!,
    name: readString(record.name, `contributes.triggers[${index}].name`)!,
    description: readString(record.description, `contributes.triggers[${index}].description`, false),
    kind: kind as PluginTriggerKind
  };
}

function readContributes(value: unknown): PluginContributes {
  const record = readRecord(value);
  const contributes: PluginContributes = {};
  if (record.providers !== undefined) {
    if (!Array.isArray(record.providers)) {
      throw new PluginManifestError("contributes.providers must be an array.");
    }
    contributes.providers = record.providers.map(readProvider);
  }
  if (record.harnesses !== undefined) {
    if (!Array.isArray(record.harnesses)) {
      throw new PluginManifestError("contributes.harnesses must be an array.");
    }
    contributes.harnesses = record.harnesses.map(readHarness);
  }
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) {
      throw new PluginManifestError("contributes.tools must be an array.");
    }
    contributes.tools = record.tools.map(readTool);
  }
  if (record.skillSources !== undefined) {
    if (!Array.isArray(record.skillSources)) {
      throw new PluginManifestError("contributes.skillSources must be an array.");
    }
    contributes.skillSources = record.skillSources.map(readSkillSource);
  }
  if (record.artifactRenderers !== undefined) {
    if (!Array.isArray(record.artifactRenderers)) {
      throw new PluginManifestError("contributes.artifactRenderers must be an array.");
    }
    contributes.artifactRenderers = record.artifactRenderers.map(readArtifactRenderer);
  }
  if (record.triggers !== undefined) {
    if (!Array.isArray(record.triggers)) {
      throw new PluginManifestError("contributes.triggers must be an array.");
    }
    contributes.triggers = record.triggers.map(readTrigger);
  }
  return contributes;
}

function contributionCount(contributes: PluginContributes): number {
  return (
    (contributes.providers?.length ?? 0) +
    (contributes.harnesses?.length ?? 0) +
    (contributes.tools?.length ?? 0) +
    (contributes.skillSources?.length ?? 0) +
    (contributes.artifactRenderers?.length ?? 0) +
    (contributes.triggers?.length ?? 0)
  );
}

/** Parse and validate a raw manifest object (no disk I/O). */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginManifestError("Plugin manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  const id = readString(record.id, "id")!;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new PluginManifestError(
      'Manifest id must be alphanumeric with optional "._-" (e.g. "hello-tool").'
    );
  }
  const name = readString(record.name, "name")!;
  const version = readString(record.version, "version")!;
  const apiVersion = readString(record.apiVersion, "apiVersion")!;
  const entry = readEntry(record.entry);
  const engine = readEngine(record.engine);
  if (!Array.isArray(record.permissions)) {
    throw new PluginManifestError("Manifest permissions must be an array.");
  }
  for (const raw of record.permissions) {
    if (typeof raw !== "string") {
      throw new PluginManifestError("Manifest permissions must be strings.");
    }
    if (normalizePermissions([raw]).length === 0) {
      throw new PluginManifestError(`Unknown permission "${raw}".`);
    }
  }
  const permissions = normalizePermissions(record.permissions) as PluginPermission[];
  const contributes = readContributes(record.contributes);
  if (contributionCount(contributes) === 0) {
    throw new PluginManifestError(
      "Manifest must contribute at least one provider, harness, tool, skill source, artifact renderer, or trigger."
    );
  }

  let configSchema: PluginJsonSchema | undefined;
  if (record.configSchema !== undefined) {
    if (!record.configSchema || typeof record.configSchema !== "object" || Array.isArray(record.configSchema)) {
      throw new PluginManifestError("configSchema must be an object.");
    }
    configSchema = record.configSchema as PluginJsonSchema;
  }

  let secretsSchema: PluginManifest["secretsSchema"];
  if (record.secretsSchema !== undefined) {
    const ss = readRecord(record.secretsSchema);
    const keys = readStringArray(ss.keys, "secretsSchema.keys");
    secretsSchema = { keys };
  }

  return {
    id,
    name,
    version,
    description: readString(record.description, "description", false),
    author: readString(record.author, "author", false),
    apiVersion,
    engine,
    entry,
    permissions,
    ...(configSchema ? { configSchema } : {}),
    ...(secretsSchema ? { secretsSchema } : {}),
    contributes
  };
}

export async function loadPluginManifest(packageRoot: string): Promise<ResolvedPluginManifest> {
  const rootDir = resolve(packageRoot);
  const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PluginManifestError(
        `No ${PLUGIN_MANIFEST_FILE} found under "${rootDir}".`
      );
    }
    throw error;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new PluginManifestError(`Invalid JSON in ${PLUGIN_MANIFEST_FILE}.`);
  }
  const manifest = parsePluginManifest(decoded);
  const mainPath = join(rootDir, manifest.entry.main);
  try {
    await access(mainPath);
  } catch {
    throw new PluginManifestError(
      `Plugin entry main "${manifest.entry.main}" does not exist under package root.`
    );
  }
  return { ...manifest, rootDir };
}

/** Stable content hash of package files (manifest + main + recursive small files). */
export async function hashPluginPackage(packageRoot: string): Promise<string> {
  const rootDir = resolve(packageRoot);
  const hash = createHash("sha256");
  await walkAndHash(rootDir, rootDir, hash);
  return hash.digest("hex");
}

async function walkAndHash(
  root: string,
  current: string,
  hash: ReturnType<typeof createHash>
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(current, entry.name);
    const rel = full.slice(root.length).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      hash.update(`dir:${rel}\n`);
      await walkAndHash(root, full, hash);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(full);
    // Cap very large binaries from hashing body; still include metadata.
    if (info.size > 2 * 1024 * 1024) {
      hash.update(`file:${rel}:size=${info.size}\n`);
      continue;
    }
    const body = await readFile(full);
    hash.update(`file:${rel}\n`);
    hash.update(body);
  }
}

export function cloneContributes(contributes: PluginContributes): PluginContributes {
  return JSON.parse(JSON.stringify(contributes)) as PluginContributes;
}
