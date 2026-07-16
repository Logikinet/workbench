import { useEffect, useState } from "react";
import { createConnectionClient, type ConnectionRecord } from "../lib/connections.js";
import { createRoleClient, type AgentRoleRecord, type RolePermissions } from "../lib/roles.js";
import {
  EmptyHint,
  Field,
  FormBlock,
  Grid2,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  SelectField,
  Stack,
  Tag,
  TextAreaField,
  TextInput
} from "./ui.js";

interface RolesPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

interface RoleDraft {
  name: string;
  responsibility: string;
  systemInstruction: string;
  connectionId: string;
  modelId: string;
  harness: "api" | "codex-cli";
  reasoningEffort: "low" | "medium" | "high";
  skills: string;
  tools: string;
  permissions: RolePermissions;
  allowFirstmateAutoInvoke: boolean;
}

const defaultPermissions: RolePermissions = {
  workspace: "project_only",
  network: false,
  shell: true,
  externalSend: false
};

const emptyDraft: RoleDraft = {
  name: "",
  responsibility: "",
  systemInstruction: "",
  connectionId: "",
  modelId: "",
  harness: "api" as const,
  reasoningEffort: "medium" as const,
  skills: "implement, tdd",
  tools: "filesystem, shell",
  permissions: defaultPermissions,
  allowFirstmateAutoInvoke: false
};

export function RolesPanel({ serviceUrl, available, dataEpoch = 0 }: RolesPanelProps) {
  const client = createRoleClient(serviceUrl);
  const connectionsClient = createConnectionClient(serviceUrl);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<AgentRoleRecord | null>(null);
  const [notice, setNotice] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      const [nextRoles, nextConnections] = await Promise.all([client.list(), connectionsClient.list()]);
      setRoles(nextRoles);
      setConnections(nextConnections.filter((connection) => connection.enabled));
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Agent Role");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch]);

  const payload = () => ({
    name: draft.name,
    responsibility: draft.responsibility,
    systemInstruction: draft.systemInstruction,
    connectionId: draft.connectionId || null,
    modelId: draft.modelId || null,
    harness: draft.harness,
    reasoningEffort: draft.reasoningEffort,
    skills: splitList(draft.skills),
    tools: splitList(draft.tools),
    permissions: draft.permissions,
    allowFirstmateAutoInvoke: draft.allowFirstmateAutoInvoke
  });

  const changeHarness = (harness: RoleDraft["harness"]) => {
    setDraft((current) =>
      harness === "codex-cli"
        ? {
            ...current,
            harness,
            connectionId: "",
            modelId: "",
            tools: ensureTools(current.tools, ["codex-cli", "filesystem", "shell"]),
            permissions: {
              ...current.permissions,
              workspace: "project_only",
              network: false,
              shell: true,
              externalSend: false
            }
          }
        : { ...current, harness }
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const changed = editing ? await client.update(editing.id, payload()) : await client.create(payload());
      setRoles((current) =>
        editing ? current.map((role) => (role.id === changed.id ? changed : role)) : [changed, ...current]
      );
      setEditing(null);
      setDraft(emptyDraft);
      setNotice(editing ? "Role 已更新。" : "Role 已创建。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存 Role");
    }
  };

  const beginEdit = (role: AgentRoleRecord) => {
    setEditing(role);
    setDraft({
      name: role.name,
      responsibility: role.responsibility,
      systemInstruction: role.systemInstruction,
      connectionId: role.connectionId ?? "",
      modelId: role.modelId ?? "",
      harness: role.harness,
      reasoningEffort: role.reasoningEffort,
      skills: role.skills.join(", "),
      tools: role.tools.join(", "),
      permissions:
        role.harness === "codex-cli"
          ? { ...role.permissions, network: false, externalSend: false }
          : role.permissions,
      allowFirstmateAutoInvoke: role.allowFirstmateAutoInvoke
    });
  };

  const update = async (role: AgentRoleRecord, change: Partial<AgentRoleRecord>) => {
    try {
      const changed = await client.update(role.id, change);
      setRoles((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
      return changed;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新 Role");
      return undefined;
    }
  };

  const verify = async (role: AgentRoleRecord) => {
    try {
      const result = await client.verify(role.id);
      setNotice(
        result.ready
          ? "Role 就绪：未启动正式 Run。"
          : `Role 未就绪：${[...result.missingSkills, ...result.missingTools, result.connection?.reason]
              .filter(Boolean)
              .join("；")}`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法验证 Role");
    }
  };

  const copy = async (role: AgentRoleRecord) => {
    try {
      const duplicate = await client.copy(role.id);
      setRoles((current) => [duplicate, ...current]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法复制 Role");
    }
  };

  const remove = async (role: AgentRoleRecord) => {
    try {
      await client.remove(role.id);
      setRoles((current) => current.filter((entry) => entry.id !== role.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法删除 Role");
    }
  };

  return (
    <Panel
      eyebrow="AGENT ROLES"
      title="Agent Role"
      description="Firstmate 的编排与安全规则受保护，不能由普通 Role 覆盖。"
      actions={
        <QuietButton onPress={() => void reload()} isDisabled={!available}>
          刷新
        </QuietButton>
      }
    >
      <FormBlock onSubmit={submit}>
        <Grid2>
          <Field label="Role 名称">
            <TextInput
              required
              aria-label="Role 名称"
              placeholder="Role 名称"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="职责">
            <TextInput
              required
              aria-label="职责"
              placeholder="职责"
              value={draft.responsibility}
              onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })}
            />
          </Field>
        </Grid2>
        <Field label="系统指令">
          <TextAreaField
            required
            aria-label="系统指令"
            placeholder="系统指令"
            value={draft.systemInstruction}
            onChange={(event) => setDraft({ ...draft, systemInstruction: event.target.value })}
          />
        </Field>
        {draft.harness === "api" ? (
          <Grid2>
            <Field label="模型连接">
              <SelectField
                aria-label="模型连接"
                value={draft.connectionId}
                onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}
              >
                <option value="">不绑定模型连接</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </SelectField>
            </Field>
            <Field label="覆盖模型 ID（可选）">
              <TextInput
                aria-label="Role 模型 ID"
                placeholder="覆盖模型 ID（可选）"
                value={draft.modelId}
                onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
              />
            </Field>
          </Grid2>
        ) : (
          <Notice tone="default">Codex CLI Role 使用本机 Codex 登录，不绑定工作台 API 连接。</Notice>
        )}
        <Grid2>
          <Field label="Harness">
            <SelectField
              aria-label="Harness"
              value={draft.harness}
              onChange={(event) => changeHarness(event.target.value as "api" | "codex-cli")}
            >
              <option value="api">API</option>
              <option value="codex-cli">Codex CLI</option>
            </SelectField>
          </Field>
          <Field label="推理强度">
            <SelectField
              aria-label="推理强度"
              value={draft.reasoningEffort}
              onChange={(event) =>
                setDraft({ ...draft, reasoningEffort: event.target.value as "low" | "medium" | "high" })
              }
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </SelectField>
          </Field>
          <Field label="Skills（逗号分隔）">
            <TextInput
              aria-label="Skills"
              placeholder="Skills（逗号分隔）"
              value={draft.skills}
              onChange={(event) => setDraft({ ...draft, skills: event.target.value })}
            />
          </Field>
          <Field label="Tools（逗号分隔）">
            <TextInput
              aria-label="Tools"
              placeholder="Tools（逗号分隔）"
              value={draft.tools}
              onChange={(event) => setDraft({ ...draft, tools: event.target.value })}
            />
          </Field>
          <Field label="工作区权限">
            <SelectField
              aria-label="工作区权限"
              value={draft.permissions.workspace}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permissions: {
                    ...draft.permissions,
                    workspace: event.target.value as RolePermissions["workspace"]
                  }
                })
              }
            >
              <option value="project_only">仅项目工作区</option>
              <option value="read_only">只读</option>
            </SelectField>
          </Field>
        </Grid2>
        <div className="flex flex-wrap gap-4 text-sm text-foreground">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              disabled={draft.harness === "codex-cli"}
              checked={draft.permissions.network}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permissions: { ...draft.permissions, network: event.target.checked }
                })
              }
            />
            允许网络
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.permissions.shell}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permissions: { ...draft.permissions, shell: event.target.checked }
                })
              }
            />
            允许 Shell
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              disabled={draft.harness === "codex-cli"}
              checked={draft.permissions.externalSend}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permissions: { ...draft.permissions, externalSend: event.target.checked }
                })
              }
            />
            允许外发
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.allowFirstmateAutoInvoke}
              onChange={(event) =>
                setDraft({ ...draft, allowFirstmateAutoInvoke: event.target.checked })
              }
            />
            允许 Firstmate 自动调用
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton type="submit" isDisabled={!available}>
            {editing ? "保存 Role" : "创建 Role"}
          </PrimaryButton>
          {editing ? (
            <QuietButton
              onPress={() => {
                setEditing(null);
                setDraft(emptyDraft);
              }}
            >
              取消
            </QuietButton>
          ) : null}
        </div>
      </FormBlock>

      {notice ? <Notice>{notice}</Notice> : null}

      <Stack>
        {roles.length === 0 ? (
          <EmptyHint>暂无 Agent Role。</EmptyHint>
        ) : (
          roles.map((role) => {
            const bound = role.connectionId
              ? connections.find((connection) => connection.id === role.connectionId)
              : undefined;
            const connectionLabel =
              role.harness === "codex-cli"
                ? "Codex CLI 本机登录"
                : bound
                  ? `连接 ${bound.name}${bound.enabled === false ? "（已停用）" : ""}`
                  : role.connectionId
                    ? "连接未在列表中 / 可能已删除"
                    : "未绑定连接";
            return (
              <ListCard
                key={role.id}
                actions={
                  <>
                    <Tag color={role.enabled ? "success" : "default"}>
                      {role.enabled ? "已启用" : "已停用"}
                    </Tag>
                    <Tag color={role.allowFirstmateAutoInvoke ? "accent" : "default"}>
                      {role.allowFirstmateAutoInvoke ? "可自动调用" : "仅手动"}
                    </Tag>
                    <QuietButton onPress={() => void verify(role)}>验证</QuietButton>
                    <QuietButton onPress={() => void copy(role)}>复制</QuietButton>
                    <QuietButton onPress={() => beginEdit(role)}>编辑</QuietButton>
                    <QuietButton onPress={() => void update(role, { enabled: !role.enabled })}>
                      {role.enabled ? "停用" : "启用"}
                    </QuietButton>
                    <QuietButton onPress={() => void remove(role)}>删除</QuietButton>
                  </>
                }
              >
                <strong className="block text-sm text-foreground">{role.name}</strong>
                <span className="block text-sm text-muted">
                  {role.harness} · {role.reasoningEffort} · {role.responsibility}
                </span>
                <small className="block text-xs text-muted">
                  能力：{role.skills.join(", ") || "—"} · 工具：{role.tools.join(", ") || "—"}
                </small>
                <small className="block text-xs text-muted">
                  连接：{connectionLabel}
                  {role.modelId ? ` · 模型 ${role.modelId}` : ""}
                </small>
                <small className="block text-xs text-muted">
                  Firstmate 自动调用：{role.allowFirstmateAutoInvoke ? "允许" : "禁止"}
                  {" · "}
                  实例：{role.enabled ? "已启用（可被路由）" : "已停用"}
                </small>
              </ListCard>
            );
          })
        )}
      </Stack>
    </Panel>
  );
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function ensureTools(value: string, required: string[]): string {
  return [...new Set([...splitList(value), ...required])].join(", ");
}
