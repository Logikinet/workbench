import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConnectionService } from "../connections/connectionService.js";

export const firstmateCoreRules = [
  "Firstmate only orchestrates; it never directly produces formal artifacts.",
  "Firstmate must require approved plans before execution and preserve security boundaries.",
  "Ordinary Agent Roles cannot override Firstmate orchestration or security rules."
].join("\n");

export type Harness = "api" | "codex-cli";
export type ReasoningEffort = "low" | "medium" | "high";

export interface RolePermissions {
  workspace: "project_only" | "read_only";
  network: boolean;
  shell: boolean;
  externalSend: boolean;
}

export interface AgentRole {
  id: string;
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId?: string;
  modelId?: string;
  harness: Harness;
  reasoningEffort: ReasoningEffort;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  roleKind?: "ordinary" | "firstmate";
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId?: string | null;
  modelId?: string | null;
  harness: Harness;
  reasoningEffort: ReasoningEffort;
  skills: string[];
  tools: string[];
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
}

export type UpdateRoleInput = Partial<Omit<CreateRoleInput, "roleKind">> & { enabled?: boolean };

export interface RoleVerification {
  ready: boolean;
  formalRunStarted: false;
  connection?: { ready: boolean; reason?: string };
  missingSkills: string[];
  missingTools: string[];
}

interface RoleState {
  schemaVersion: 1;
  roles: AgentRole[];
}

export interface RoleStateSnapshot {
  schemaVersion: 1;
  roles: AgentRole[];
}

const availableSkills = new Set(["implement", "tdd", "code-review", "research", "documents", "skill-creator"]);
const availableTools = new Set(["filesystem", "shell", "web", "git", "model-api", "codex-cli"]);

function emptyState(): RoleState { return { schemaVersion: 1, roles: [] }; }

export class RoleService {
  readonly firstmateCoreRules = firstmateCoreRules;

  private constructor(
    private readonly statePath: string,
    private state: RoleState,
    private readonly connections: ConnectionService
  ) {}

  static async open(statePath: string, connections: ConnectionService): Promise<RoleService> {
    try {
      const decoded = JSON.parse(await readFile(statePath, "utf8")) as Partial<RoleState>;
      if (decoded.schemaVersion !== 1 || !Array.isArray(decoded.roles)) throw new Error("Role state is not compatible with this service version.");
      return new RoleService(statePath, decoded as RoleState, connections);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new RoleService(statePath, emptyState(), connections);
      throw error;
    }
  }

  async list(): Promise<AgentRole[]> {
    return [...this.state.roles].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(roleId: string): Promise<AgentRole> {
    const role = this.state.roles.find((entry) => entry.id === roleId);
    if (!role) throw new Error(`Agent Role ${roleId} was not found.`);
    return role;
  }

  /** Full durable snapshot for backup export (Role config only — no credentials). */
  async exportSnapshot(): Promise<RoleStateSnapshot> {
    return {
      schemaVersion: 1,
      roles: structuredClone(this.state.roles)
    };
  }

  /** Replace all Agent Roles from a validated backup snapshot. */
  async importSnapshot(snapshot: RoleStateSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.roles)) {
      throw new Error("Role backup snapshot is not compatible with this service version.");
    }
    this.state = {
      schemaVersion: 1,
      roles: structuredClone(snapshot.roles)
    };
    await this.persist();
  }

  async create(input: CreateRoleInput): Promise<AgentRole> {
    if (input.roleKind === "firstmate") throw new Error("Firstmate cannot be configured as an ordinary Agent Role.");
    const role = this.createRecord(input, randomUUID(), new Date().toISOString());
    if (role.connectionId) await this.connections.get(role.connectionId);
    this.state.roles.push(role);
    await this.persist();
    return role;
  }

  async copy(roleId: string, name?: string): Promise<AgentRole> {
    const source = await this.get(roleId);
    const now = new Date().toISOString();
    const copy: AgentRole = {
      ...source,
      id: randomUUID(),
      name: name?.trim() || `${source.name} 副本`,
      skills: [...source.skills],
      tools: [...source.tools],
      permissions: { ...source.permissions },
      createdAt: now,
      updatedAt: now
    };
    this.state.roles.push(copy);
    await this.persist();
    return copy;
  }

  async update(roleId: string, input: UpdateRoleInput): Promise<AgentRole> {
    const role = await this.get(roleId);
    const next = this.createRecord({
      name: input.name ?? role.name,
      responsibility: input.responsibility ?? role.responsibility,
      systemInstruction: input.systemInstruction ?? role.systemInstruction,
      connectionId: input.connectionId !== undefined ? input.connectionId : role.connectionId,
      modelId: input.modelId !== undefined ? input.modelId : role.modelId,
      harness: input.harness ?? role.harness,
      reasoningEffort: input.reasoningEffort ?? role.reasoningEffort,
      skills: input.skills ?? role.skills,
      tools: input.tools ?? role.tools,
      permissions: input.permissions ?? role.permissions,
      allowFirstmateAutoInvoke: input.allowFirstmateAutoInvoke ?? role.allowFirstmateAutoInvoke
    }, role.id, role.createdAt);
    next.enabled = input.enabled ?? role.enabled;
    if (next.connectionId) await this.connections.get(next.connectionId);
    Object.assign(role, next);
    await this.persist();
    return role;
  }

  async remove(roleId: string): Promise<void> {
    await this.get(roleId);
    this.state.roles = this.state.roles.filter((entry) => entry.id !== roleId);
    await this.persist();
  }

  async verify(roleId: string): Promise<RoleVerification> {
    const role = await this.get(roleId);
    const missingSkills = role.skills.filter((skill) => !availableSkills.has(skill));
    const missingTools = role.tools.filter((tool) => !availableTools.has(tool));
    let connection: RoleVerification["connection"];
    if (!role.enabled) connection = { ready: false, reason: "Role 已停用。" };
    else if (role.connectionId) {
      try {
        const configured = await this.connections.get(role.connectionId);
        if (!configured.enabled) connection = { ready: false, reason: "模型连接已停用。" };
        else {
          const tested = await this.connections.test(configured.id, role.modelId, { notifyOnUnavailable: false });
          connection = tested.kind === "success" ? { ready: true } : { ready: false, reason: tested.message };
        }
      } catch {
        connection = { ready: false, reason: "模型连接不存在或已删除。" };
      }
    } else if (role.harness === "api") connection = { ready: false, reason: "API Harness 需要模型连接。" };

    return {
      ready: role.enabled && missingSkills.length === 0 && missingTools.length === 0 && (connection?.ready ?? true),
      formalRunStarted: false,
      connection,
      missingSkills,
      missingTools
    };
  }

  private createRecord(input: Omit<CreateRoleInput, "roleKind">, id: string, createdAt: string): AgentRole {
    const now = new Date().toISOString();
    if (input.harness !== "api" && input.harness !== "codex-cli") throw new Error("Harness is invalid.");
    if (!["low", "medium", "high"].includes(input.reasoningEffort)) throw new Error("Reasoning effort is invalid.");
    return {
      id,
      name: required(input.name, "A Role name is required."),
      responsibility: required(input.responsibility, "A Role responsibility is required."),
      systemInstruction: required(input.systemInstruction, "A system instruction is required."),
      connectionId: input.connectionId || undefined,
      modelId: input.modelId?.trim() || undefined,
      harness: input.harness,
      reasoningEffort: input.reasoningEffort,
      skills: uniqueStrings(input.skills),
      tools: uniqueStrings(input.tools),
      permissions: validatePermissions(input.permissions),
      allowFirstmateAutoInvoke: input.allowFirstmateAutoInvoke,
      enabled: true,
      createdAt,
      updatedAt: now
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: constants.S_IRUSR | constants.S_IWUSR });
    await rename(temporaryPath, this.statePath);
  }
}

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  if (!Array.isArray(values)) throw new Error("Skills and Tools must be arrays.");
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validatePermissions(permissions: RolePermissions): RolePermissions {
  if (
    !permissions
    || (permissions.workspace !== "project_only" && permissions.workspace !== "read_only")
    || typeof permissions.network !== "boolean"
    || typeof permissions.shell !== "boolean"
    || typeof permissions.externalSend !== "boolean"
  ) throw new Error("Role permissions are invalid.");
  return { ...permissions };
}
