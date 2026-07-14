/**
 * Firstmate self-management tool catalog + invoker (Task 36).
 *
 * Exposes machine-readable tool specs for the Firstmate model loop and a
 * single `invokeFirstmateTool` entrypoint. Callers must not invent enum values
 * or edit internal databases — use listed tools and roles.schema.
 */

import type { FirstmateSelfManagementService } from "./firstmateSelfManagementService.js";
import type {
  CreateRoleToolInput,
  CreateTemporaryAgentInput,
  FirstmateToolName,
  FirstmateToolResult,
  FirstmateToolSpec,
  RemoveRoleToolInput,
  UpdateRoleToolInput
} from "./firstmateTypes.js";

const rolePermissionsSchema = {
  type: "object",
  properties: {
    workspace: { type: "string", enum: ["project_only", "read_only"] },
    network: { type: "boolean" },
    shell: { type: "boolean" },
    externalSend: { type: "boolean" }
  },
  required: ["workspace", "network", "shell", "externalSend"]
} as const;

/** Static catalog — schemas are the source of truth for allowed values. */
export const FIRSTMATE_TOOL_SPECS: readonly FirstmateToolSpec[] = [
  {
    name: "roles.list",
    description: "List all Agent Roles (public fields; marks built-in Firstmate).",
    risk: "read",
    category: "roles",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "roles.get",
    description: "Get one Agent Role by id. Step 1 of the config mutation workflow.",
    risk: "read",
    category: "roles",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { roleId: { type: "string" } },
      required: ["roleId"]
    }
  },
  {
    name: "roles.schema",
    description:
      "Return the Agent Role JSON schema and enums. Step 2 of config mutation: read current → schema → minimal patch → re-read verify.",
    risk: "read",
    category: "roles",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "roles.create",
    description:
      "Create a long-term Agent Role. Requires userRequested=true (never silent). Prefer agents.temporary.create for run-scoped teammates.",
    risk: "write",
    category: "roles",
    requiresUserRequest: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        responsibility: { type: "string" },
        systemInstruction: { type: "string" },
        connectionId: { type: ["string", "null"] },
        modelId: { type: ["string", "null"] },
        harness: { type: "string", enum: ["api", "codex-cli"] },
        reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
        skills: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
        permissions: rolePermissionsSchema,
        allowFirstmateAutoInvoke: { type: "boolean" },
        reason: { type: "string" },
        actor: { type: "string" },
        userRequested: { type: "boolean", description: "Must be true — explicit user request" }
      },
      required: [
        "name",
        "responsibility",
        "systemInstruction",
        "harness",
        "reasoningEffort",
        "skills",
        "tools",
        "permissions",
        "allowFirstmateAutoInvoke",
        "userRequested"
      ]
    }
  },
  {
    name: "roles.update",
    description:
      "Update a long-term Role via fixed workflow read→schema→minimal patch→verify. Requires userRequested=true. Supply only changed fields in patch.",
    risk: "write",
    category: "roles",
    requiresUserRequest: true,
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string" },
        patch: {
          type: "object",
          description: "Minimal patch — omit unchanged fields",
          properties: {
            name: { type: "string" },
            responsibility: { type: "string" },
            systemInstruction: { type: "string" },
            connectionId: { type: ["string", "null"] },
            modelId: { type: ["string", "null"] },
            harness: { type: "string", enum: ["api", "codex-cli"] },
            reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
            skills: { type: "array", items: { type: "string" } },
            tools: { type: "array", items: { type: "string" } },
            permissions: rolePermissionsSchema,
            allowFirstmateAutoInvoke: { type: "boolean" },
            enabled: { type: "boolean" }
          }
        },
        reason: { type: "string" },
        actor: { type: "string" },
        userRequested: { type: "boolean" }
      },
      required: ["roleId", "patch", "userRequested"]
    }
  },
  {
    name: "roles.remove",
    description:
      "Remove a long-term Agent Role. Built-in Firstmate cannot be deleted. Requires userRequested=true.",
    risk: "dangerous",
    category: "roles",
    requiresUserRequest: true,
    inputSchema: {
      type: "object",
      properties: {
        roleId: { type: "string" },
        reason: { type: "string" },
        actor: { type: "string" },
        userRequested: { type: "boolean" }
      },
      required: ["roleId", "userRequested"]
    }
  },
  {
    name: "agents.temporary.create",
    description:
      "Create a run-scoped temporary agent with name, responsibility, avatar, runtime (harness), skills, tools, and permissions. Not added to the long-term Role library.",
    risk: "write",
    category: "temporary_agents",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        responsibility: { type: "string" },
        systemInstruction: { type: "string" },
        avatar: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["emoji", "url", "color"] },
            value: { type: "string" }
          },
          required: ["kind", "value"]
        },
        connectionId: { type: ["string", "null"] },
        modelId: { type: ["string", "null"] },
        harness: { type: "string", enum: ["api", "codex-cli"] },
        reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
        skills: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
        permissions: {
          type: "object",
          properties: {
            workspace: { type: "string", enum: ["project_only", "read_only"] },
            network: { type: "boolean" },
            shell: { type: "boolean" },
            externalSend: { type: "boolean" }
          }
        },
        allowFirstmateAutoInvoke: { type: "boolean" },
        reason: { type: "string" },
        actor: { type: "string" }
      },
      required: ["name", "responsibility", "harness"]
    }
  },
  {
    name: "agents.temporary.list",
    description: "List temporary agents created via self-management tools.",
    risk: "read",
    category: "temporary_agents",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "agents.temporary.get",
    description: "Get one temporary agent by id.",
    risk: "read",
    category: "temporary_agents",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { temporaryAgentId: { type: "string" } },
      required: ["temporaryAgentId"]
    }
  },
  {
    name: "agents.temporary.remove",
    description: "Discard a temporary agent (run-scoped only).",
    risk: "write",
    category: "temporary_agents",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: {
        temporaryAgentId: { type: "string" },
        reason: { type: "string" },
        actor: { type: "string" }
      },
      required: ["temporaryAgentId"]
    }
  },
  {
    name: "runtimes.list",
    description: "Discover registered Runtime adapters (harness, readiness, capabilities). Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "runtimes.get",
    description: "Get one Runtime adapter by harness id. Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { harness: { type: "string" } },
      required: ["harness"]
    }
  },
  {
    name: "connections.list",
    description:
      "List model connections as status + capability summaries. Secrets are never returned.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "connections.get",
    description: "Get one connection status summary (no secrets).",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"]
    }
  },
  {
    name: "skills.list",
    description: "List Skill catalog entries. Read-only discovery.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "skills.get",
    description: "Get one Skill by id. Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { skillId: { type: "string" } },
      required: ["skillId"]
    }
  },
  {
    name: "tools.list",
    description: "List Tool registry entries. Read-only discovery.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "tools.get",
    description: "Get one Tool by id. Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { toolId: { type: "string" } },
      required: ["toolId"]
    }
  },
  {
    name: "projects.list",
    description: "List Projects. Read-only discovery.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "projects.get",
    description: "Get one Project by id. Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"]
    }
  },
  {
    name: "runs.list",
    description: "List recent Runs (status summary). Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } }
    }
  },
  {
    name: "runs.get",
    description: "Get one Run status summary. Read-only.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"]
    }
  },
  {
    name: "queue.status",
    description: "Read queue concurrency status, active leases, and resource pause flags.",
    risk: "read",
    category: "discovery",
    requiresUserRequest: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "audit.list",
    description: "List management audit timeline (actor, reason, before/after, result).",
    risk: "read",
    category: "audit",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } }
    }
  },
  {
    name: "audit.get",
    description: "Get one audit entry by id.",
    risk: "read",
    category: "audit",
    requiresUserRequest: false,
    inputSchema: {
      type: "object",
      properties: { auditId: { type: "string" } },
      required: ["auditId"]
    }
  }
] as const;

const SPEC_BY_NAME = new Map(FIRSTMATE_TOOL_SPECS.map((spec) => [spec.name, spec]));

export function listFirstmateToolSpecs(): FirstmateToolSpec[] {
  return FIRSTMATE_TOOL_SPECS.map((spec) => ({
    ...spec,
    inputSchema: structuredClone(spec.inputSchema)
  }));
}

export function getFirstmateToolSpec(name: string): FirstmateToolSpec {
  const spec = SPEC_BY_NAME.get(name as FirstmateToolName);
  if (!spec) throw Object.assign(new Error(`Firstmate tool "${name}" was not found.`), { code: "not_found" });
  return { ...spec, inputSchema: structuredClone(spec.inputSchema) };
}

/**
 * Invoke a self-management tool by name with machine-readable args.
 * Returns structured FirstmateToolResult (ok/error, never secrets).
 */
export async function invokeFirstmateTool(
  service: FirstmateSelfManagementService,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<FirstmateToolResult> {
  const name = toolName as FirstmateToolName;
  if (!SPEC_BY_NAME.has(name)) {
    return {
      ok: false,
      tool: name,
      summary: `Unknown Firstmate tool "${toolName}". Call tools catalog first.`,
      error: `Unknown Firstmate tool "${toolName}".`,
      code: "not_found"
    };
  }

  try {
    switch (name) {
      case "roles.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed Agent Roles.",
          data: { roles: await service.listRoles() }
        };
      case "roles.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded role ${String(args.roleId)}.`,
          data: await service.getRole(String(args.roleId ?? ""))
        };
      case "roles.schema":
        return {
          ok: true,
          tool: name,
          summary: "Returned Agent Role config schema.",
          data: service.roleSchema()
        };
      case "roles.create":
        return service.createRole(args as unknown as CreateRoleToolInput);
      case "roles.update":
        return service.updateRole({
          roleId: String(args.roleId ?? ""),
          patch: (args.patch ?? {}) as UpdateRoleToolInput["patch"],
          reason: typeof args.reason === "string" ? args.reason : undefined,
          actor: typeof args.actor === "string" ? args.actor : undefined,
          userRequested: args.userRequested === true
        });
      case "roles.remove":
        return service.removeRole({
          roleId: String(args.roleId ?? ""),
          reason: typeof args.reason === "string" ? args.reason : undefined,
          actor: typeof args.actor === "string" ? args.actor : undefined,
          userRequested: args.userRequested === true
        } satisfies RemoveRoleToolInput);
      case "agents.temporary.create":
        return service.createTemporaryAgent(args as unknown as CreateTemporaryAgentInput);
      case "agents.temporary.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed temporary agents.",
          data: { temporaryAgents: service.listTemporaryAgents() }
        };
      case "agents.temporary.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded temporary agent ${String(args.temporaryAgentId)}.`,
          data: service.getTemporaryAgent(String(args.temporaryAgentId ?? ""))
        };
      case "agents.temporary.remove":
        return service.removeTemporaryAgent(String(args.temporaryAgentId ?? ""), {
          reason: typeof args.reason === "string" ? args.reason : undefined,
          actor: typeof args.actor === "string" ? args.actor : undefined
        });
      case "runtimes.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed runtimes.",
          data: { runtimes: await service.listRuntimes() }
        };
      case "runtimes.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded runtime ${String(args.harness)}.`,
          data: await service.getRuntime(String(args.harness ?? ""))
        };
      case "connections.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed connections (secrets omitted).",
          data: { connections: await service.listConnections() }
        };
      case "connections.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded connection ${String(args.connectionId)} (secrets omitted).`,
          data: await service.getConnection(String(args.connectionId ?? ""))
        };
      case "skills.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed skills.",
          data: { skills: service.listSkills() }
        };
      case "skills.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded skill ${String(args.skillId)}.`,
          data: service.getSkill(String(args.skillId ?? ""))
        };
      case "tools.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed tools.",
          data: { tools: service.listTools() }
        };
      case "tools.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded tool ${String(args.toolId)}.`,
          data: service.getTool(String(args.toolId ?? ""))
        };
      case "projects.list":
        return {
          ok: true,
          tool: name,
          summary: "Listed projects.",
          data: { projects: await service.listProjects() }
        };
      case "projects.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded project ${String(args.projectId)}.`,
          data: await service.getProject(String(args.projectId ?? ""))
        };
      case "runs.list": {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        return {
          ok: true,
          tool: name,
          summary: "Listed runs.",
          data: { runs: await service.listRuns(limit) }
        };
      }
      case "runs.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded run ${String(args.runId)}.`,
          data: await service.getRun(String(args.runId ?? ""))
        };
      case "queue.status":
        return {
          ok: true,
          tool: name,
          summary: "Loaded queue status.",
          data: await service.queueStatus()
        };
      case "audit.list": {
        const limit = typeof args.limit === "number" ? args.limit : 100;
        return {
          ok: true,
          tool: name,
          summary: "Listed audit timeline.",
          data: { audit: service.listAudit(limit) }
        };
      }
      case "audit.get":
        return {
          ok: true,
          tool: name,
          summary: `Loaded audit ${String(args.auditId)}.`,
          data: service.getAudit(String(args.auditId ?? ""))
        };
      default: {
        const _exhaustive: never = name;
        return {
          ok: false,
          tool: _exhaustive,
          summary: "Unhandled tool.",
          error: "Unhandled tool.",
          code: "internal"
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool invocation failed.";
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : message.toLowerCase().includes("not found")
          ? "not_found"
          : "internal";
    return {
      ok: false,
      tool: name,
      summary: message,
      error: message,
      code: code as FirstmateToolResult["code"]
    };
  }
}
