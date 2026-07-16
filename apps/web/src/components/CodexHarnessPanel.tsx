import { useEffect, useState } from "react";
import { createRoleClient, type AgentRoleRecord } from "../lib/roles.js";
import { createRunClient, type CodexCliStatusRecord, type RunRecord } from "../lib/runs.js";
import {
  Field,
  Panel,
  PrimaryButton,
  QuietButton,
  SelectField,
  Stack,
  Tag
} from "./ui.js";

interface CodexHarnessPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
}

export function CodexHarnessPanel({ serviceUrl, run, onRunChange, onNotice }: CodexHarnessPanelProps) {
  const runClient = createRunClient(serviceUrl);
  const roleClient = createRoleClient(serviceUrl);
  const [status, setStatus] = useState<CodexCliStatusRecord | null>(null);
  const [roles, setRoles] = useState<AgentRoleRecord[]>([]);
  const [roleId, setRoleId] = useState("");

  const reload = async () => {
    try {
      const [nextStatus, nextRoles] = await Promise.all([runClient.codexCliStatus(), roleClient.list()]);
      const codexRoles = nextRoles.filter((role) => role.enabled && role.harness === "codex-cli");
      setStatus(nextStatus);
      setRoles(codexRoles);
      setRoleId((current) => current || codexRoles[0]?.id || "");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法读取 Codex CLI 状态或 Role");
    }
  };

  useEffect(() => {
    void reload();
  }, [serviceUrl, run.id]);

  const start = async () => {
    try {
      const changed = await runClient.executeCodexCli(run.id, { roleId });
      onRunChange(changed);
      if (changed.status === "running") {
        onNotice("Firstmate 已在当前 Project 工作目录启动 Codex CLI；输出会持续写入此 Run 时间线。");
      } else {
        onNotice(
          `Codex CLI 已暂停：${changed.execution.lastError ?? changed.timeline.at(-1)?.summary ?? "请根据时间线处理后重试。"}`
        );
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法启动 Codex CLI");
    }
  };

  const ready = Boolean(status?.installed && status.authenticated);

  return (
    <Panel
      eyebrow="CODEX CLI HARNESS"
      title="在已批准的 Project 中执行"
      description="Codex 使用本机登录与受限工作区运行，不使用工作台保存的 API 密钥；此非交互 Harness 会关闭网络与外发能力。"
      actions={<QuietButton onPress={() => void reload()}>重新检测</QuietButton>}
    >
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-4">
        <Tag color={ready ? "success" : "warning"}>{ready ? "Codex CLI 已就绪" : "Codex CLI 不可用"}</Tag>
        {status?.version ? <span className="text-sm text-muted">{status.version}</span> : null}
        {!ready ? (
          <span className="text-sm text-muted">{status?.reason ?? "正在检测本机 Codex CLI。"}</span>
        ) : null}
      </div>

      {run.execution.status === "idle" ? (
        <Stack>
          <Field label="已有 Codex CLI Role">
            <SelectField
              aria-label="已有 Codex CLI Role"
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
            >
              <option value="">选择 Role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} · {role.responsibility}
                </option>
              ))}
            </SelectField>
          </Field>
          <PrimaryButton isDisabled={!ready || !roleId} onPress={() => void start()}>
            启动 Codex CLI
          </PrimaryButton>
        </Stack>
      ) : null}
    </Panel>
  );
}
