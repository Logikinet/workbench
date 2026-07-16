import { useState } from "react";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import {
  createRoutingClient,
  type RouteDecisionInput,
  type RoutingDecisionRecord
} from "../lib/routing.js";
import {
  EmptyHint,
  Field,
  Grid2,
  ListCard,
  Panel,
  PrimaryButton,
  SelectField,
  Stack,
  Tag,
  TextInput
} from "./ui.js";

interface RoleRouterPanelProps {
  serviceUrl: string;
  available: boolean;
  /** Optional Run id to attach to the routing decision / queue payload. */
  runId?: string;
  onNotice?(message: string): void;
}

/**
 * Small Firstmate role-router inspector (Task 20).
 * Shows auto selection (role / model / harness / reason), allows override,
 * and can confirm temporary roles into the long-term library.
 * Mount from App when routing API is wired in the service.
 */
export function RoleRouterPanel({ serviceUrl, available, runId, onNotice }: RoleRouterPanelProps) {
  const routing = createRoutingClient(serviceUrl);
  const rolesClient = createRoleClient(serviceUrl);
  const [capabilities, setCapabilities] = useState("filesystem, shell, tests");
  const [complexity, setComplexity] = useState<"low" | "medium" | "high">("low");
  const [planApproved, setPlanApproved] = useState(true);
  const [decision, setDecision] = useState<RoutingDecisionRecord | null>(null);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [overrideRoleId, setOverrideRoleId] = useState("");
  const [busy, setBusy] = useState(false);

  const notify = (message: string) => onNotice?.(message);

  const runRoute = async () => {
    if (!available) return;
    setBusy(true);
    try {
      const payload: RouteDecisionInput = {
        runId,
        complexity,
        planApproved,
        requiredCapabilities: splitList(capabilities)
      };
      const next = await routing.route(payload);
      setDecision(next);
      const listed = await rolesClient.list();
      setRoles(listed.filter((role) => role.enabled));
      if (!overrideRoleId && listed[0]) setOverrideRoleId(listed[0].id);
      notify(next.canAutoQueue ? "角色已就绪，可直接入队执行。" : next.autoQueueBlockedReason ?? "路由完成。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法路由角色");
    } finally {
      setBusy(false);
    }
  };

  const applyOverride = async () => {
    if (!decision || !overrideRoleId) return;
    setBusy(true);
    try {
      const next = await routing.override(decision.id, { roleId: overrideRoleId });
      setDecision(next);
      notify("已应用用户覆盖选择。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法覆盖角色");
    } finally {
      setBusy(false);
    }
  };

  const confirmTemporary = async (temporaryRoleId: string) => {
    if (!decision) return;
    setBusy(true);
    try {
      const result = await routing.confirmTemporary(decision.id, {
        temporaryRoleId,
        confirm: true
      });
      setDecision(result.decision);
      notify(`临时角色已确认并保存为长期角色「${result.role.name}」。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法确认临时角色");
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <Panel title="Firstmate 角色路由">
        <EmptyHint>服务不可用，无法预览自动角色选择。</EmptyHint>
      </Panel>
    );
  }

  return (
    <Panel
      eyebrow="ROLE ROUTING"
      title="Firstmate 角色路由"
      description="计划批准后按能力 / Harness / Skills / Tools / 权限 / 启用状态 / allowFirstmateAutoInvoke 自动匹配；可在执行前覆盖；临时角色需确认后才进入长期库。"
    >
      <Grid2>
        <Field label="所需能力（逗号分隔）">
          <TextInput
            value={capabilities}
            onChange={(event) => setCapabilities(event.target.value)}
          />
        </Field>
        <Field label="复杂度">
          <SelectField
            value={complexity}
            onChange={(event) => setComplexity(event.target.value as typeof complexity)}
          >
            <option value="low">简单（单角色）</option>
            <option value="medium">中等</option>
            <option value="high">复杂（可多实例）</option>
          </SelectField>
        </Field>
      </Grid2>
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={planApproved}
          onChange={(event) => setPlanApproved(event.target.checked)}
        />
        计划已批准（可自动入队）
      </label>
      <PrimaryButton isDisabled={busy} onPress={() => void runRoute()}>
        自动选择角色
      </PrimaryButton>

      {decision ? (
        <Stack>
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm text-foreground">决策 {decision.id.slice(0, 8)}…</strong>
            {decision.canAutoQueue ? (
              <Tag color="success">可直接入队</Tag>
            ) : (
              <Tag color="warning">{decision.autoQueueBlockedReason ?? "不可自动入队"}</Tag>
            )}
          </div>
          <pre className="m-0 whitespace-pre-wrap rounded-lg border border-border bg-field p-3 text-xs text-muted">
            {decision.explanation}
          </pre>

          {decision.instances.map((instance) => (
            <ListCard
              key={instance.instanceId}
              actions={
                <>
                  <Tag color="default">{instance.status}</Tag>
                  {instance.temporaryRole && !instance.temporaryRole.confirmedForLongTerm ? (
                    <PrimaryButton
                      size="sm"
                      isDisabled={busy}
                      onPress={() => void confirmTemporary(instance.temporaryRole!.id)}
                    >
                      确认保存为长期角色
                    </PrimaryButton>
                  ) : null}
                </>
              }
            >
              <strong className="block text-sm text-foreground">{instance.instanceName}</strong>
              {instance.selection ? (
                <ul className="m-0 list-none space-y-0.5 p-0 text-sm text-muted">
                  <li>角色：{instance.selection.name}</li>
                  <li>模型：{instance.selection.modelId ?? "默认"}</li>
                  <li>Harness：{instance.selection.harness}</li>
                  <li>来源：{instance.selection.source}</li>
                </ul>
              ) : null}
              <p className="m-0 text-sm text-muted">{instance.reason}</p>
            </ListCard>
          ))}

          <Grid2>
            <Field label="执行前覆盖为">
              <SelectField
                value={overrideRoleId}
                onChange={(event) => setOverrideRoleId(event.target.value)}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.harness}
                    {role.modelId ? ` / ${role.modelId}` : ""})
                  </option>
                ))}
              </SelectField>
            </Field>
          </Grid2>
          <PrimaryButton isDisabled={busy || !overrideRoleId} onPress={() => void applyOverride()}>
            应用用户覆盖
          </PrimaryButton>
        </Stack>
      ) : (
        <EmptyHint>运行「自动选择角色」后显示路由决策与实例。</EmptyHint>
      )}
    </Panel>
  );
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
}
