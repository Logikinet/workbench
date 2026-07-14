/**
 * Firstmate self-management tool surface (Task 36).
 *
 * Mount routes from main / app.ts (owned elsewhere):
 *
 *   import { createFirstmateRouter, FirstmateSelfManagementService } from "../firstmate/index.js";
 *   const firstmate = new FirstmateSelfManagementService({ roles, connections, skills, tools, ... });
 *   app.use(createFirstmateRouter({ firstmate }));
 */

export {
  FirstmateSelfManagementService,
  isBuiltinFirstmate,
  toPublicRole,
  computeDiff,
  type RolesClient,
  type ConnectionsClient,
  type SkillsClient,
  type ToolsClient,
  type ProjectsClient,
  type RunsClient,
  type QueueClient,
  type RuntimesClient,
  type FirstmateSelfManagementOptions
} from "./firstmateSelfManagementService.js";

export {
  FIRSTMATE_TOOL_SPECS,
  listFirstmateToolSpecs,
  getFirstmateToolSpec,
  invokeFirstmateTool
} from "./firstmateTools.js";

export {
  createFirstmateRouter,
  createFirstmateRouteApp,
  type FirstmateRouteDeps
} from "./firstmateRoutes.js";

export {
  FIRSTMATE_BUILTIN_ROLE_ID,
  FIRSTMATE_NAME_PATTERN,
  type FirstmateToolName,
  type FirstmateToolSpec,
  type FirstmateToolResult,
  type FirstmateToolRisk,
  type FirstmateToolCategory,
  type FirstmateAvatar,
  type FirstmateAvatarKind,
  type TemporaryAgent,
  type CreateTemporaryAgentInput,
  type CreateRoleToolInput,
  type UpdateRoleToolInput,
  type RemoveRoleToolInput,
  type AuditEntry,
  type AuditResultKind,
  type PublicRoleView,
  type RuntimeDiscoveryView,
  type ConnectionDiscoveryView,
  type SkillDiscoveryView,
  type ToolDiscoveryView,
  type ProjectDiscoveryView,
  type RunDiscoveryView,
  type QueueDiscoveryView,
  type RoleConfigSchema,
  type RolePatchCycleResult,
  type FirstmateErrorCode
} from "./firstmateTypes.js";
