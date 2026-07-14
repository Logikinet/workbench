/**
 * Unified Tool Registry (Task 22).
 * Distinguishes readonly / write / shell / network / dangerous tools.
 * Trust + enable gates first-use exposure; never bypasses workspace/approval policy.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BUILTIN_TOOL_SPECS,
  TOOL_PERMISSION_CATEGORIES,
  type RegisterToolInput,
  type ToolDefinition,
  type ToolPermissionCategory,
  type ToolState
} from "./toolTypes.js";

export interface ToolRegistryOptions {
  /** Durable state path; when omitted, registry is memory-only. */
  statePath?: string;
  /** When false, skip seeding built-in tools (tests). Default true. */
  seedBuiltins?: boolean;
}

function emptyState(): ToolState {
  return { schemaVersion: 1, tools: [] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isCategory(value: unknown): value is ToolPermissionCategory {
  return typeof value === "string" && (TOOL_PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

export class ToolRegistry {
  private constructor(
    private readonly statePath: string | undefined,
    private state: ToolState
  ) {}

  static async open(options: ToolRegistryOptions = {}): Promise<ToolRegistry> {
    const seedBuiltins = options.seedBuiltins !== false;
    let state = emptyState();

    if (options.statePath) {
      try {
        const decoded = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<ToolState>;
        if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.tools)) {
          throw new Error("Tool registry state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          tools: decoded.tools.map(normalizePersistedTool)
        };
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const registry = new ToolRegistry(options.statePath, state);
    if (seedBuiltins) {
      await registry.ensureBuiltins();
    }
    return registry;
  }

  /** In-memory factory for unit tests. */
  static async createMemory(options: { seedBuiltins?: boolean } = {}): Promise<ToolRegistry> {
    return ToolRegistry.open({ seedBuiltins: options.seedBuiltins !== false });
  }

  list(filter?: { category?: ToolPermissionCategory; enabled?: boolean; trusted?: boolean }): ToolDefinition[] {
    return this.state.tools
      .filter((tool) => {
        if (filter?.category && tool.category !== filter.category) return false;
        if (filter?.enabled !== undefined && tool.enabled !== filter.enabled) return false;
        if (filter?.trusted !== undefined && tool.trusted !== filter.trusted) return false;
        return true;
      })
      .map(cloneTool)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(toolId: string): ToolDefinition {
    const tool = this.find(toolId);
    if (!tool) throw new Error(`Tool "${toolId}" was not found.`);
    return cloneTool(tool);
  }

  tryGet(toolId: string): ToolDefinition | undefined {
    const tool = this.find(toolId);
    return tool ? cloneTool(tool) : undefined;
  }

  has(toolId: string): boolean {
    return this.find(toolId) !== undefined;
  }

  /** Resolve by id or name (name-only Role migration). */
  resolveByNameOrId(nameOrId: string): ToolDefinition | undefined {
    const key = nameOrId.trim();
    if (!key) return undefined;
    const exact = this.find(key);
    if (exact) return cloneTool(exact);
    const byName = this.state.tools.find((tool) => tool.name === key || tool.id === key);
    return byName ? cloneTool(byName) : undefined;
  }

  async register(input: RegisterToolInput): Promise<ToolDefinition> {
    const id = required(input.id, "A tool id is required.");
    if (this.find(id)) {
      throw new Error(`Tool "${id}" is already registered.`);
    }
    if (!isCategory(input.category)) {
      throw new Error(
        `Tool category is invalid. Expected one of: ${TOOL_PERMISSION_CATEGORIES.join(", ")}.`
      );
    }
    const source = input.source ?? "registered";
    const trusted = input.trusted ?? source === "builtin";
    const requiresApproval =
      input.requiresApproval
      ?? (input.category === "dangerous" || input.category === "shell" || input.category === "network");
    const timestamp = nowIso();
    const tool: ToolDefinition = {
      id,
      name: required(input.name, "A tool name is required."),
      description: required(input.description, "A tool description is required."),
      version: (input.version?.trim() || "1.0.0"),
      category: input.category,
      source,
      enabled: input.enabled ?? true,
      trusted,
      trustedAt: trusted ? timestamp : undefined,
      requiresApproval,
      inputSchema: input.inputSchema,
      tags: uniqueStrings(input.tags ?? []),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.state.tools.push(tool);
    await this.persist();
    return cloneTool(tool);
  }

  async setEnabled(toolId: string, enabled: boolean): Promise<ToolDefinition> {
    const tool = this.find(toolId);
    if (!tool) throw new Error(`Tool "${toolId}" was not found.`);
    tool.enabled = enabled;
    tool.updatedAt = nowIso();
    await this.persist();
    return cloneTool(tool);
  }

  async trust(toolId: string): Promise<ToolDefinition> {
    const tool = this.find(toolId);
    if (!tool) throw new Error(`Tool "${toolId}" was not found.`);
    const timestamp = nowIso();
    tool.trusted = true;
    tool.trustedAt = timestamp;
    tool.updatedAt = timestamp;
    await this.persist();
    return cloneTool(tool);
  }

  async revokeTrust(toolId: string): Promise<ToolDefinition> {
    const tool = this.find(toolId);
    if (!tool) throw new Error(`Tool "${toolId}" was not found.`);
    if (tool.source === "builtin" && tool.category !== "dangerous") {
      throw new Error(`Cannot revoke trust for built-in tool "${toolId}".`);
    }
    tool.trusted = false;
    tool.trustedAt = undefined;
    tool.updatedAt = nowIso();
    await this.persist();
    return cloneTool(tool);
  }

  categories(): readonly ToolPermissionCategory[] {
    return TOOL_PERMISSION_CATEGORIES;
  }

  /** Snapshot of all tools for timeline / backup. */
  snapshot(): { schemaVersion: 1; tools: ToolDefinition[]; capturedAt: string } {
    return {
      schemaVersion: 1,
      tools: this.state.tools.map(cloneTool),
      capturedAt: nowIso()
    };
  }

  private find(toolId: string): ToolDefinition | undefined {
    const key = toolId.trim();
    return this.state.tools.find((tool) => tool.id === key);
  }

  private async ensureBuiltins(): Promise<void> {
    let changed = false;
    for (const spec of BUILTIN_TOOL_SPECS) {
      if (this.find(spec.id)) continue;
      const timestamp = nowIso();
      this.state.tools.push({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        version: spec.version ?? "1.0.0",
        category: spec.category,
        source: "builtin",
        enabled: spec.enabled ?? true,
        trusted: spec.trusted ?? true,
        trustedAt: (spec.trusted ?? true) ? timestamp : undefined,
        requiresApproval:
          spec.requiresApproval
          ?? (spec.category === "dangerous" || spec.category === "shell" || spec.category === "network"),
        tags: uniqueStrings(spec.tags ?? []),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: constants.S_IRUSR | constants.S_IWUSR
    });
    await rename(temporaryPath, this.statePath);
  }
}

function cloneTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    tags: tool.tags ? [...tool.tags] : undefined,
    inputSchema: tool.inputSchema ? structuredClone(tool.inputSchema) : undefined
  };
}

function normalizePersistedTool(value: unknown): ToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool registry entry is invalid.");
  }
  const entry = value as Partial<ToolDefinition>;
  if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("Tool registry entry missing id.");
  if (!isCategory(entry.category)) throw new Error(`Tool "${entry.id}" has invalid category.`);
  const timestamp = typeof entry.createdAt === "string" ? entry.createdAt : nowIso();
  return {
    id: entry.id.trim(),
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id.trim(),
    description: typeof entry.description === "string" ? entry.description : "",
    version: typeof entry.version === "string" && entry.version.trim() ? entry.version.trim() : "1.0.0",
    category: entry.category,
    source: entry.source === "mcp" || entry.source === "registered" || entry.source === "builtin" ? entry.source : "registered",
    enabled: entry.enabled !== false,
    trusted: entry.trusted === true,
    trustedAt: typeof entry.trustedAt === "string" ? entry.trustedAt : undefined,
    requiresApproval: entry.requiresApproval === true,
    inputSchema: entry.inputSchema && typeof entry.inputSchema === "object" ? entry.inputSchema : undefined,
    tags: Array.isArray(entry.tags) ? uniqueStrings(entry.tags.filter((t): t is string => typeof t === "string")) : [],
    createdAt: timestamp,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : timestamp
  };
}

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
