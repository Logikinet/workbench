/**
 * Firstmate Role Router (Task 20) + Deterministic routing / session isolation (Task 38).
 */

export {
  RoleRouterService,
  deriveInstances,
  rankCandidates,
  deriveSkillToolPermission,
  type PlanComplexity,
  type TaskType,
  type InstanceRequirement,
  type RouteRequest,
  type RoleMatchCandidate,
  type TemporaryRoleDraft,
  type InstanceRouteStatus,
  type PauseCode,
  type SelectedRoleSummary,
  type RoutedInstance,
  type RoutingDecision,
  type AutoQueuePayload,
  type OverrideInput,
  type ConfirmTemporaryInput,
  type RoleRouterServiceOptions
} from "./roleRouterService.js";

export {
  createRoutingRouter,
  type RoutingRouteDeps
} from "./routingRoutes.js";

export {
  evaluateRoutingRules,
  matchRuleAgainstContext,
  manualOverrideRejects,
  normalizeRoutingRule,
  permissionInsufficient,
  roleEligibilityRejects,
  sortRules,
  type RoutingRule,
  type RoutingRuleInput,
  type RoutingRuleMatch,
  type RuleEvaluation,
  type RuleEvaluationResult,
  type RuleMatchContext,
  type RuleMatchResult
} from "./routingRules.js";

export {
  SESSION_SCOPE_KINDS,
  allowsPrivateMemory,
  allowedMemoryLayers,
  assertNoCrossLeak,
  assertScopeValid,
  buildSessionKey,
  canShareContext,
  createSessionLocalConfig,
  filterContextForScope,
  isSessionScopeKind,
  parseSessionKey,
  resolveSessionModelId,
  type ContextShareDecision,
  type CreateSessionLocalInput,
  type IsolationViolation,
  type SessionLocalConfig,
  type SessionScopeKind,
  type SessionScopeRef
} from "./sessionScopes.js";

export {
  DeterministicRoutingService,
  type DeterministicRouteRequest,
  type DeterministicRoutingDecision,
  type DeterministicRoutingServiceOptions,
  type SelectionMode,
  type SelectionTrace
} from "./deterministicRoutingService.js";
