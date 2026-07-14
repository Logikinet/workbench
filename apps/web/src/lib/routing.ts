import { createJsonRequest } from "./apiClient.js";

export interface RoutingSelection {
  instanceId: string;
  roleId?: string;
  temporaryRoleId?: string;
  source: "role" | "temporary" | "user_specified" | "user_override";
  name: string;
  harness: "api" | "codex-cli";
  modelId?: string;
  connectionId?: string;
  skills: string[];
  tools: string[];
}

export interface RoutedInstanceView {
  instanceId: string;
  instanceName: string;
  status: "selected" | "temporary" | "user_specified" | "user_override" | "paused";
  selection?: {
    source: RoutingSelection["source"];
    roleId?: string;
    temporaryRoleId?: string;
    name: string;
    modelId?: string;
    harness: "api" | "codex-cli";
    connectionId?: string;
    skills: string[];
    tools: string[];
  };
  reason: string;
  pauseReason?: string;
  pauseCode?: string;
  temporaryRole?: {
    id: string;
    name: string;
    confirmedForLongTerm: boolean;
    longTermRoleId?: string;
  };
}

export interface RoutingDecisionRecord {
  id: string;
  runId?: string;
  complexity: "low" | "medium" | "high";
  instances: RoutedInstanceView[];
  canAutoQueue: boolean;
  autoQueueBlockedReason?: string;
  explanation: string;
  queuePayload: {
    decisionId: string;
    runId?: string;
    planApproved: boolean;
    selections: RoutingSelection[];
  };
}

export interface RouteDecisionInput {
  runId?: string;
  complexity?: "low" | "medium" | "high";
  requiredCapabilities?: string[];
  requiredSkills?: string[];
  requiredTools?: string[];
  preferredHarness?: "api" | "codex-cli";
  explicitRoleId?: string;
  planApproved?: boolean;
  defaultConnectionId?: string;
  defaultModelId?: string;
  instances?: Array<{
    id: string;
    name?: string;
    capabilities?: string[];
    skills?: string[];
    tools?: string[];
    harness?: "api" | "codex-cli";
  }>;
}

export function createRoutingClient(serviceUrl: string) {
  const requestJson = createJsonRequest(serviceUrl);
  return {
    route: (payload: RouteDecisionInput) =>
      requestJson<RoutingDecisionRecord>("/api/routing/decisions", {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    list: () => requestJson<RoutingDecisionRecord[]>("/api/routing/decisions"),
    get: (decisionId: string) =>
      requestJson<RoutingDecisionRecord>(`/api/routing/decisions/${encodeURIComponent(decisionId)}`),
    override: (decisionId: string, payload: { roleId: string; instanceId?: string }) =>
      requestJson<RoutingDecisionRecord>(`/api/routing/decisions/${encodeURIComponent(decisionId)}/override`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    confirmTemporary: (decisionId: string, payload: { temporaryRoleId: string; confirm: true; name?: string }) =>
      requestJson<{ decision: RoutingDecisionRecord; role: { id: string; name: string } }>(
        `/api/routing/decisions/${encodeURIComponent(decisionId)}/confirm-temporary`,
        { method: "POST", body: JSON.stringify(payload) }
      )
  };
}
