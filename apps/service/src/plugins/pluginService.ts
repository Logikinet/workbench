/**
 * Plugin lifecycle service (Task 46).
 * Local install / enable / disable / update / rollback / uninstall with
 * permission isolation, process isolation, config/secrets split, and
 * core upgrade compatibility checks.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkPluginCompatibility } from "./pluginCompat.js";
import { PluginHost, type PluginHostOptions } from "./pluginHost.js";
import {
  cloneContributes,
  hashPluginPackage,
  loadPluginManifest
} from "./pluginManifest.js";
import { normalizePermissions, validatePermissionApproval } from "./pluginPermissions.js";
import { PluginContributionRegistry } from "./pluginRegistry.js";
import {
  type EnablePluginInput,
  type InstallPluginInput,
  type PluginBackupSlice,
  type PluginCompatResult,
  type PluginInstallRecord,
  type PluginInstallStatus,
  type PluginState,
  type PluginVersionSnapshot,
  type PublicPluginRecord,
  type ResolvedPluginManifest,
  type RollbackPluginInput,
  type UpdatePluginInput
} from "./pluginTypes.js";

/** Same vault shape as connections/MCP — injectable. */
export interface CredentialVault {
  read(reference: string): Promise<string | undefined>;
  write(reference: string, secret: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

export interface PluginServiceOptions {
  /** Durable inventory path. Memory-only when omitted. */
  statePath?: string;
  /** Directory where installed plugin packages are copied. */
  installRoot: string;
  /** Host core version for engine compatibility (e.g. package.json version). */
  coreVersion: string;
  vault?: CredentialVault;
  host?: PluginHost;
  hostOptions?: PluginHostOptions;
  registry?: PluginContributionRegistry;
  /** Max rollback history entries per plugin (default 10). */
  maxHistory?: number;
}

const MAX_HISTORY_DEFAULT = 10;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(coreVersion: string): PluginState {
  return { schemaVersion: 1, coreVersion, plugins: {} };
}

export class MemoryPluginVault implements CredentialVault {
  private readonly store = new Map<string, string>();

  async read(reference: string): Promise<string | undefined> {
    return this.store.get(reference);
  }

  async write(reference: string, secret: string): Promise<void> {
    this.store.set(reference, secret);
  }

  async remove(reference: string): Promise<void> {
    this.store.delete(reference);
  }
}

export class PluginService {
  private state: PluginState;
  private readonly maxHistory: number;
  private readonly vault: CredentialVault;
  private host: PluginHost;
  readonly registry: PluginContributionRegistry;
  private readonly crashNotes = new Map<string, string>();

  private constructor(
    private readonly statePath: string | undefined,
    private readonly installRoot: string,
    state: PluginState,
    vault: CredentialVault,
    host: PluginHost,
    registry: PluginContributionRegistry,
    maxHistory: number
  ) {
    this.state = state;
    this.vault = vault;
    this.host = host;
    this.registry = registry;
    this.maxHistory = maxHistory;
  }

  static async open(options: PluginServiceOptions): Promise<PluginService> {
    const installRoot = resolve(options.installRoot);
    await mkdir(installRoot, { recursive: true });

    let state = emptyState(options.coreVersion);
    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<PluginState>;
        if (decoded.schemaVersion !== 1 || !decoded.plugins || typeof decoded.plugins !== "object") {
          throw new Error("Plugin state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          coreVersion:
            typeof decoded.coreVersion === "string" && decoded.coreVersion.trim()
              ? decoded.coreVersion
              : options.coreVersion,
          plugins: decoded.plugins as Record<string, PluginInstallRecord>
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }

    const vault = options.vault ?? new MemoryPluginVault();
    const registry = options.registry ?? new PluginContributionRegistry();

    // Placeholder host; replaced below so crash handler can close over `service`.
    const service = new PluginService(
      options.statePath,
      installRoot,
      state,
      vault,
      options.host ?? new PluginHost(),
      registry,
      options.maxHistory ?? MAX_HISTORY_DEFAULT
    );

    if (!options.host) {
      const userOnCrash = options.hostOptions?.onCrash;
      service.host = new PluginHost({
        ...options.hostOptions,
        onCrash: (pluginId, detail) => {
          void service.handlePluginCrash(pluginId, detail);
          userOnCrash?.(pluginId, detail);
        }
      });
    }

    // Apply compatibility against configured core version on open.
    await service.applyCoreCompatibility(options.coreVersion, {
      persist: false,
      stopIncompatible: false
    });
    await service.persist();
    return service;
  }

  /** In-memory factory for unit/contract tests. */
  static async createMemory(
    options: Omit<PluginServiceOptions, "statePath"> & { statePath?: string }
  ): Promise<PluginService> {
    return PluginService.open(options);
  }

  getCoreVersion(): string {
    return this.state.coreVersion;
  }

  getHost(): PluginHost {
    return this.host;
  }

  list(): PublicPluginRecord[] {
    return Object.values(this.state.plugins)
      .map((record) => this.toPublic(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(pluginId: string): PublicPluginRecord {
    return this.toPublic(this.requireRecord(pluginId));
  }

  tryGet(pluginId: string): PublicPluginRecord | undefined {
    const record = this.state.plugins[pluginId];
    return record ? this.toPublic(record) : undefined;
  }

  getInstallRecord(pluginId: string): PluginInstallRecord {
    return cloneRecord(this.requireRecord(pluginId));
  }

  async install(input: InstallPluginInput): Promise<PublicPluginRecord> {
    if (input.confirm !== true) {
      throw new Error("Installing a plugin requires confirm: true.");
    }
    const sourcePath = resolve(input.sourcePath);
    const manifest = await loadPluginManifest(sourcePath);

    if (this.state.plugins[manifest.id]) {
      throw new Error(
        `Plugin "${manifest.id}" is already installed. Use update() or uninstall() first.`
      );
    }

    const approval = validatePermissionApproval({
      declared: manifest.permissions,
      approved: input.approvedPermissions,
      requireAllDeclared: input.requireAllDeclared
    });
    if (!approval.ok) {
      throw new Error(
        `Permission approval failed: ${approval.denials.map((d) => d.reason).join(" ")}`
      );
    }

    const compat = checkPluginCompatibility(manifest, this.state.coreVersion);
    const contentHash = await hashPluginPackage(sourcePath);
    const installPath = join(this.installRoot, manifest.id, "current");
    await rm(installPath, { recursive: true, force: true });
    await mkdir(dirname(installPath), { recursive: true });
    await cp(sourcePath, installPath, { recursive: true });

    const credentialRef = `plugin:${manifest.id}:secrets`;
    const secretKeys = await this.writeSecrets(
      credentialRef,
      manifest.secretsSchema?.keys ?? [],
      input.secrets
    );

    const timestamp = nowIso();
    const status: PluginInstallStatus = compat.compatible ? "installed" : "incompatible";
    const record: PluginInstallRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      apiVersion: manifest.apiVersion,
      engine: { ...manifest.engine },
      installPath,
      contentHash,
      enabled: false,
      status,
      approvedPermissions: approval.approved,
      declaredPermissions: [...manifest.permissions],
      config: sanitizeConfig(input.config ?? {}),
      secretKeys,
      credentialRef: secretKeys.length > 0 ? credentialRef : undefined,
      history: [],
      lastError: compat.compatible ? undefined : compat.reasons.join(" "),
      installedAt: timestamp,
      updatedAt: timestamp
    };

    this.state.plugins[manifest.id] = record;
    await this.persist();
    return this.toPublic(record);
  }

  async enable(input: EnablePluginInput | string): Promise<PublicPluginRecord> {
    const pluginId = typeof input === "string" ? input : input.pluginId;
    const extraApprovals =
      typeof input === "string" ? undefined : input.approvedPermissions;
    const record = this.requireRecord(pluginId);

    if (extraApprovals?.length) {
      const approval = validatePermissionApproval({
        declared: record.declaredPermissions,
        approved: normalizePermissions([
          ...record.approvedPermissions,
          ...extraApprovals
        ]),
        requireAllDeclared: false
      });
      if (!approval.ok) {
        throw new Error(
          `Permission approval failed: ${approval.denials.map((d) => d.reason).join(" ")}`
        );
      }
      record.approvedPermissions = approval.approved;
    }

    const manifest = await loadPluginManifest(record.installPath);
    const compat = checkPluginCompatibility(manifest, this.state.coreVersion);
    if (!compat.compatible) {
      record.status = "incompatible";
      record.enabled = false;
      record.lastError = compat.reasons.join(" ");
      record.updatedAt = nowIso();
      await this.persist();
      throw new Error(
        `Cannot enable incompatible plugin "${pluginId}": ${compat.reasons.join(" ")}`
      );
    }

    // Register contributions under approved permissions only.
    this.registry.unregisterPlugin(pluginId);
    this.registry.registerFromManifest({
      pluginId,
      contributes: manifest.contributes,
      approvedPermissions: record.approvedPermissions
    });

    try {
      const handle = await this.host.start({ ...manifest, rootDir: record.installPath });
      record.processId = handle.pid;
    } catch (error) {
      this.registry.unregisterPlugin(pluginId);
      record.status = "crashed";
      record.enabled = false;
      record.lastError = error instanceof Error ? error.message : String(error);
      record.updatedAt = nowIso();
      await this.persist();
      throw error;
    }

    record.enabled = true;
    record.status = "enabled";
    record.lastError = undefined;
    record.updatedAt = nowIso();
    this.crashNotes.delete(pluginId);
    await this.persist();
    return this.toPublic(record);
  }

  async disable(pluginId: string): Promise<PublicPluginRecord> {
    const record = this.requireRecord(pluginId);
    await this.host.stop(pluginId);
    this.registry.unregisterPlugin(pluginId);
    record.enabled = false;
    record.processId = undefined;
    // Preserve terminal diagnostic statuses; otherwise mark disabled.
    if (record.status !== "incompatible" && record.status !== "crashed") {
      record.status = "disabled";
    }
    record.updatedAt = nowIso();
    await this.persist();
    return this.toPublic(record);
  }

  async update(input: UpdatePluginInput): Promise<PublicPluginRecord> {
    if (input.confirm !== true) {
      throw new Error("Updating a plugin requires confirm: true.");
    }
    const record = this.requireRecord(input.pluginId);
    const sourcePath = resolve(input.sourcePath);
    const newManifest = await loadPluginManifest(sourcePath);
    if (newManifest.id !== record.id) {
      throw new Error(
        `Update package id "${newManifest.id}" does not match installed plugin "${record.id}".`
      );
    }

    let approved = record.approvedPermissions;
    if (input.approvedPermissions) {
      const approval = validatePermissionApproval({
        declared: newManifest.permissions,
        approved: input.approvedPermissions,
        requireAllDeclared: true
      });
      if (!approval.ok) {
        throw new Error(
          `Permission approval failed: ${approval.denials.map((d) => d.reason).join(" ")}`
        );
      }
      approved = approval.approved;
    } else if (input.preserveApprovals !== false) {
      const approval = validatePermissionApproval({
        declared: newManifest.permissions,
        approved: record.approvedPermissions,
        requireAllDeclared: true
      });
      if (!approval.ok) {
        throw new Error(
          `Update declares new permissions that are not approved: ${approval.denials
            .map((d) => d.reason)
            .join(" ")}. Pass approvedPermissions explicitly.`
        );
      }
      approved = approval.approved;
    }

    const wasEnabled = record.enabled;
    if (wasEnabled) {
      await this.host.stop(record.id);
      this.registry.unregisterPlugin(record.id);
    }

    // Snapshot current for rollback.
    const archivePath = join(
      this.installRoot,
      record.id,
      "history",
      `${record.version}-${record.contentHash.slice(0, 12)}`
    );
    await mkdir(dirname(archivePath), { recursive: true });
    await rm(archivePath, { recursive: true, force: true });
    await cp(record.installPath, archivePath, { recursive: true });
    const snapshot: PluginVersionSnapshot = {
      version: record.version,
      contentHash: record.contentHash,
      archivePath,
      capturedAt: nowIso()
    };
    record.history = [snapshot, ...record.history].slice(0, this.maxHistory);

    const contentHash = await hashPluginPackage(sourcePath);
    await rm(record.installPath, { recursive: true, force: true });
    await mkdir(dirname(record.installPath), { recursive: true });
    await cp(sourcePath, record.installPath, { recursive: true });

    if (input.secrets && record.credentialRef) {
      record.secretKeys = await this.writeSecrets(
        record.credentialRef,
        newManifest.secretsSchema?.keys ?? record.secretKeys,
        input.secrets
      );
    } else if (input.secrets) {
      const credentialRef = `plugin:${record.id}:secrets`;
      record.credentialRef = credentialRef;
      record.secretKeys = await this.writeSecrets(
        credentialRef,
        newManifest.secretsSchema?.keys ?? [],
        input.secrets
      );
    }

    if (input.config) {
      record.config = sanitizeConfig({ ...record.config, ...input.config });
    }

    record.name = newManifest.name;
    record.version = newManifest.version;
    record.description = newManifest.description;
    record.author = newManifest.author;
    record.apiVersion = newManifest.apiVersion;
    record.engine = { ...newManifest.engine };
    record.contentHash = contentHash;
    record.declaredPermissions = [...newManifest.permissions];
    record.approvedPermissions = approved;
    record.enabled = false;
    record.status = "installed";
    record.updatedAt = nowIso();
    record.lastError = undefined;

    const compat = checkPluginCompatibility(newManifest, this.state.coreVersion);
    if (!compat.compatible) {
      record.status = "incompatible";
      record.lastError = compat.reasons.join(" ");
    }

    await this.persist();

    if (wasEnabled && compat.compatible) {
      return this.enable(record.id);
    }
    return this.toPublic(record);
  }

  async rollback(input: RollbackPluginInput): Promise<PublicPluginRecord> {
    if (input.confirm !== true) {
      throw new Error("Rolling back a plugin requires confirm: true.");
    }
    const record = this.requireRecord(input.pluginId);
    if (record.history.length === 0) {
      throw new Error(`Plugin "${record.id}" has no rollback history.`);
    }
    const snapshot = input.version
      ? record.history.find((h) => h.version === input.version)
      : record.history[0];
    if (!snapshot) {
      throw new Error(
        `No history entry for version "${input.version}" on plugin "${record.id}".`
      );
    }

    const wasEnabled = record.enabled;
    if (wasEnabled) {
      await this.host.stop(record.id);
      this.registry.unregisterPlugin(record.id);
    }

    // Archive current before restoring.
    const currentArchive = join(
      this.installRoot,
      record.id,
      "history",
      `pre-rollback-${record.version}-${Date.now()}`
    );
    await mkdir(dirname(currentArchive), { recursive: true });
    await cp(record.installPath, currentArchive, { recursive: true });

    await rm(record.installPath, { recursive: true, force: true });
    await cp(snapshot.archivePath, record.installPath, { recursive: true });

    const restoredManifest = await loadPluginManifest(record.installPath);
    record.version = restoredManifest.version;
    record.name = restoredManifest.name;
    record.description = restoredManifest.description;
    record.apiVersion = restoredManifest.apiVersion;
    record.engine = { ...restoredManifest.engine };
    record.contentHash = snapshot.contentHash;
    record.declaredPermissions = [...restoredManifest.permissions];
    // Keep only approvals still declared.
    record.approvedPermissions = record.approvedPermissions.filter((p) =>
      restoredManifest.permissions.includes(p)
    );
    record.history = record.history.filter(
      (h) => !(h.version === snapshot.version && h.contentHash === snapshot.contentHash)
    );
    record.enabled = false;
    record.status = "installed";
    record.updatedAt = nowIso();
    record.lastError = undefined;

    const compat = checkPluginCompatibility(restoredManifest, this.state.coreVersion);
    if (!compat.compatible) {
      record.status = "incompatible";
      record.lastError = compat.reasons.join(" ");
    }

    await this.persist();
    if (wasEnabled && compat.compatible) {
      return this.enable(record.id);
    }
    return this.toPublic(record);
  }

  async uninstall(pluginId: string, options: { confirm: true }): Promise<void> {
    if (options.confirm !== true) {
      throw new Error("Uninstalling a plugin requires confirm: true.");
    }
    const record = this.requireRecord(pluginId);
    await this.host.stop(pluginId);
    this.registry.unregisterPlugin(pluginId);
    if (record.credentialRef) {
      try {
        await this.vault.remove(record.credentialRef);
      } catch {
        // best-effort secret cleanup
      }
    }
    const pluginRoot = join(this.installRoot, pluginId);
    await rm(pluginRoot, { recursive: true, force: true });
    delete this.state.plugins[pluginId];
    this.crashNotes.delete(pluginId);
    await this.persist();
  }

  /**
   * Called when core upgrades. Incompatible plugins are auto-disabled
   * and marked with a user-visible reason.
   */
  async applyCoreCompatibility(
    coreVersion: string,
    options: { persist?: boolean; stopIncompatible?: boolean } = {}
  ): Promise<PluginCompatResult[]> {
    this.state.coreVersion = coreVersion;
    const results: PluginCompatResult[] = [];
    const stopIncompatible = options.stopIncompatible !== false;

    for (const record of Object.values(this.state.plugins)) {
      let manifest: ResolvedPluginManifest;
      try {
        manifest = await loadPluginManifest(record.installPath);
      } catch (error) {
        const result: PluginCompatResult = {
          compatible: false,
          pluginId: record.id,
          pluginVersion: record.version,
          coreVersion,
          apiVersionOk: false,
          engineOk: false,
          reasons: [
            error instanceof Error ? error.message : "Failed to load plugin manifest."
          ]
        };
        results.push(result);
        record.status = "incompatible";
        record.enabled = false;
        record.lastError = result.reasons.join(" ");
        if (stopIncompatible) {
          await this.host.stop(record.id);
          this.registry.unregisterPlugin(record.id);
        }
        continue;
      }

      const compat = checkPluginCompatibility(manifest, coreVersion);
      results.push(compat);
      if (!compat.compatible) {
        record.status = "incompatible";
        record.enabled = false;
        record.lastError = compat.reasons.join(" ");
        if (stopIncompatible) {
          await this.host.stop(record.id);
          this.registry.unregisterPlugin(record.id);
        }
      } else if (record.status === "incompatible") {
        // Restored compatibility — leave disabled until operator re-enables.
        record.status = record.enabled ? "enabled" : "disabled";
        record.lastError = undefined;
      }
    }

    if (options.persist !== false) {
      await this.persist();
    }
    return results;
  }

  /**
   * Mark a plugin crashed after isolated process death.
   * Host service continues running.
   */
  async handlePluginCrash(pluginId: string, detail: string): Promise<void> {
    const record = this.state.plugins[pluginId];
    if (!record) return;
    this.registry.unregisterPlugin(pluginId);
    record.enabled = false;
    record.status = "crashed";
    record.lastError = detail;
    record.processId = undefined;
    record.updatedAt = nowIso();
    this.crashNotes.set(pluginId, detail);
    await this.persist();
  }

  /**
   * Secret-free backup slice — ordinary backups never include secret values.
   */
  exportBackupSlice(): PluginBackupSlice {
    return {
      secretsExcluded: true,
      plugins: Object.values(this.state.plugins)
        .map((record) => ({
          id: record.id,
          name: record.name,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          approvedPermissions: [...record.approvedPermissions],
          config: { ...record.config },
          secretKeys: [...record.secretKeys],
          credentialRef: record.credentialRef
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  /** Read secret values for a plugin (requires secrets.read approval at call site). */
  async readSecrets(pluginId: string): Promise<Record<string, string> | undefined> {
    const record = this.requireRecord(pluginId);
    if (!record.credentialRef) return undefined;
    const raw = await this.vault.read(record.credentialRef);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  /** Invoke a running plugin (isolated). */
  async requestPlugin<T = unknown>(
    pluginId: string,
    kind: string,
    payload?: Record<string, unknown>
  ): Promise<T> {
    const handle = this.host.getHandle(pluginId);
    if (!handle) {
      throw new Error(`Plugin "${pluginId}" is not running.`);
    }
    return handle.request<T>(kind, payload);
  }

  async shutdown(): Promise<void> {
    await this.host.stopAll();
  }

  private requireRecord(pluginId: string): PluginInstallRecord {
    const record = this.state.plugins[pluginId];
    if (!record) {
      throw new Error(`Plugin "${pluginId}" was not found.`);
    }
    return record;
  }

  private toPublic(record: PluginInstallRecord): PublicPluginRecord {
    const fromRegistry = this.registry.listAll().filter((c) => c.pluginId === record.id);
    const contributes =
      fromRegistry.length > 0
        ? contributionsFromRegistry(fromRegistry)
        : ({} as PublicPluginRecord["contributes"]);

    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      author: record.author,
      apiVersion: record.apiVersion,
      engine: { ...record.engine },
      enabled: record.enabled,
      status: record.status,
      approvedPermissions: [...record.approvedPermissions],
      declaredPermissions: [...record.declaredPermissions],
      config: { ...record.config },
      secretKeys: [...record.secretKeys],
      secretsPresent: record.secretKeys.length > 0,
      secretsExcluded: true,
      contributes,
      lastError: record.lastError,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt
    };
  }

  /**
   * Async detail including contributes loaded from the installed manifest.
   */
  async getDetail(pluginId: string): Promise<PublicPluginRecord> {
    const record = this.requireRecord(pluginId);
    const publicRow = this.toPublic(record);
    try {
      const manifest = await loadPluginManifest(record.installPath);
      publicRow.contributes = cloneContributes(manifest.contributes);
    } catch {
      // keep registry-derived contributes
    }
    return publicRow;
  }

  private async writeSecrets(
    credentialRef: string,
    allowedKeys: string[],
    secrets: Record<string, string> | undefined
  ): Promise<string[]> {
    if (!secrets || Object.keys(secrets).length === 0) {
      return [];
    }
    const allowed = new Set(allowedKeys);
    const stored: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (!allowed.has(key)) {
        throw new Error(
          `Secret key "${key}" is not declared in the plugin secretsSchema.`
        );
      }
      if (typeof value !== "string" || !value) {
        throw new Error(`Secret "${key}" must be a non-empty string.`);
      }
      stored[key] = value;
    }
    // Merge with existing vault payload when present.
    const existingRaw = await this.vault.read(credentialRef);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as Record<string, string>;
        for (const [key, value] of Object.entries(existing)) {
          if (allowed.has(key) && stored[key] === undefined) {
            stored[key] = value;
          }
        }
      } catch {
        // replace corrupt payload
      }
    }
    await this.vault.write(credentialRef, JSON.stringify(stored));
    return Object.keys(stored).sort();
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.statePath);
  }
}

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Strip obvious secret-looking keys from ordinary config.
  const blocked = /password|secret|token|api[_-]?key|credential/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (blocked.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value === null) {
      out[key] = null;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
      out[key] = value;
    } else if (value && typeof value === "object") {
      out[key] = sanitizeConfig(value as Record<string, unknown>);
    }
  }
  return out;
}

function cloneRecord(record: PluginInstallRecord): PluginInstallRecord {
  return JSON.parse(JSON.stringify(record)) as PluginInstallRecord;
}

function contributionsFromRegistry(
  entries: Array<{ kind: string; contributionId: string; contribution: unknown }>
): PublicPluginRecord["contributes"] {
  const contributes: PublicPluginRecord["contributes"] = {};
  for (const entry of entries) {
    switch (entry.kind) {
      case "provider":
        contributes.providers = contributes.providers ?? [];
        contributes.providers.push(entry.contribution as never);
        break;
      case "harness":
        contributes.harnesses = contributes.harnesses ?? [];
        contributes.harnesses.push(entry.contribution as never);
        break;
      case "tool":
        contributes.tools = contributes.tools ?? [];
        contributes.tools.push(entry.contribution as never);
        break;
      case "skill_source":
        contributes.skillSources = contributes.skillSources ?? [];
        contributes.skillSources.push(entry.contribution as never);
        break;
      case "artifact_renderer":
        contributes.artifactRenderers = contributes.artifactRenderers ?? [];
        contributes.artifactRenderers.push(entry.contribution as never);
        break;
      case "trigger":
        contributes.triggers = contributes.triggers ?? [];
        contributes.triggers.push(entry.contribution as never);
        break;
      default:
        break;
    }
  }
  return contributes;
}

