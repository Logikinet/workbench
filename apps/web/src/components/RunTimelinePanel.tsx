import { useEffect, useMemo, useState } from "react";
import { createChatBridge, statusZh } from "../lib/chatBridge.js";
import { createRunClient, reconcileRunSelection, type RunRecord } from "../lib/runs.js";
import type { TodoRecord } from "../lib/todos.js";
import { PlanningApprovalPanel } from "./PlanningApprovalPanel.js";
import { AskUserPanel } from "./AskUserPanel.js";
import { ProfessionalAgentPanel } from "./ProfessionalAgentPanel.js";
import { CodexHarnessPanel } from "./CodexHarnessPanel.js";
import { GitWorktreePanel } from "./GitWorktreePanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { CheckpointRecoveryPanel } from "./CheckpointRecoveryPanel.js";
import { SubtaskDagPanel } from "./SubtaskDagPanel.js";
import { AgentDispatchPanel } from "./AgentDispatchPanel.js";
import {
  Divider,
  EmptyHint,
  Field,
  FormBlock,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  SelectField,
  Stack,
  Tag,
  TextInput
} from "./ui.js";

interface RunTimelinePanelProps {
  serviceUrl: string;
  todo: TodoRecord;
  onClose(): void;
  onTodoChange?(todo: TodoRecord): void;
}

export function RunTimelinePanel({ serviceUrl, todo, onClose, onTodoChange }: RunTimelinePanelProps) {
  const client = createRunClient(serviceUrl);
  const bridge = useMemo(() => createChatBridge(serviceUrl), [serviceUrl]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = useMemo(() => runs.find((run) => run.id === selectedId), [runs, selectedId]);
  const compared = useMemo(() => runs.find((run) => run.id === compareId), [runs, compareId]);

  const defaultInstruction = useMemo(() => {
    const parts = [todo.title, todo.description].filter((part) => part?.trim());
    return parts.join("\n").trim() || "请开始执行此任务";
  }, [todo.title, todo.description]);

  const reload = async () => {
    try {
      const history = await client.list(todo.id);
      setRuns(history);
      const nextSelectedId = reconcileRunSelection(
        history.map((run) => run.id),
        selectedId
      );
      setSelectedId(nextSelectedId);
      setCompareId((current) =>
        current !== nextSelectedId && history.some((run) => run.id === current) ? current : ""
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Run 历史");
    }
  };

  useEffect(() => {
    void reload();
  }, [todo.id]);

  useEffect(() => {
    if (selected?.execution.status !== "running" && selected?.status !== "waiting_for_user") return;
    const timer = window.setInterval(() => {
      void reload();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.execution.status, selected?.status, todo.id]);

  /** Start planning (todos: stop at Plan ready). */
  const startGo = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const instruction = message.trim() || defaultInstruction;
      const planned = await bridge.startTodoPlan(todo.id, instruction);
      setRuns((current) => [planned.run, ...current.filter((entry) => entry.id !== planned.run.id)]);
      setSelectedId(planned.run.id);
      setMessage("");
      setNotice(planned.notice);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法开始规划");
    } finally {
      setBusy(false);
    }
  };

  /** todos: Confirm to build */
  const continueGo = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await bridge.confirmToBuild(selected.id);
      setRuns((current) => current.map((run) => (run.id === result.run.id ? result.run : run)));
      setNotice(result.notice);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法确认并构建");
    } finally {
      setBusy(false);
    }
  };

  const addMessage = async () => {
    if (!selected || !message.trim() || busy) return;
    setBusy(true);
    try {
      let changed = await client.addMessage(selected.id, message);
      if (
        changed.status === "waiting_for_user" ||
        changed.planning?.approvalStatus === "awaiting_input"
      ) {
        try {
          changed = await client.updatePlanning(changed.id, {
            additionalContext: message.trim()
          });
        } catch {
          /* keep */
        }
      }
      setRuns((current) => current.map((run) => (run.id === changed.id ? changed : run)));
      setMessage("");
      setNotice("指令已追加。Plan ready 时请点「确认并构建」。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法添加消息");
    } finally {
      setBusy(false);
    }
  };

  const replaceRun = (changed: RunRecord) => {
    setRuns((current) => current.map((run) => (run.id === changed.id ? changed : run)));
  };

  const canContinue =
    !!selected &&
    (selected.status === "awaiting_plan_approval" ||
      selected.status === "queued" ||
      selected.status === "created" ||
      selected.planning?.approvalStatus === "awaiting_approval");

  return (
    <Panel
      eyebrow="任务执行"
      title={todo.title}
      description="todos 流程：开始规划 → Plan ready → 确认并构建 → Building → Review"
      actions={<QuietButton onPress={onClose}>关闭</QuietButton>}
    >
      <FormBlock onSubmit={startGo}>
        <Field label="任务说明（可留空）">
          <TextInput
            aria-label="任务说明"
            placeholder={defaultInstruction.slice(0, 80) || "描述你要做什么…"}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton type="submit" isDisabled={busy}>
            {busy ? "处理中…" : "开始规划"}
          </PrimaryButton>
          {canContinue ? (
            <PrimaryButton type="button" isDisabled={busy} onPress={() => void continueGo()}>
              确认并构建
            </PrimaryButton>
          ) : null}
          {selected ? (
            <QuietButton onPress={() => void addMessage()} isDisabled={busy}>
              追加说明
            </QuietButton>
          ) : null}
        </div>
      </FormBlock>

      <div className="flex flex-wrap gap-2">
        {runs.map((run) => (
          <QuietButton
            key={run.id}
            className={selectedId === run.id ? "ring-2 ring-accent" : undefined}
            onPress={() => setSelectedId(run.id)}
          >
            第 {run.attempt} 次 · {statusZh(run.status)}
          </QuietButton>
        ))}
      </div>

      {runs.length > 1 ? (
        <Field label="对比历史 Run">
          <SelectField
            aria-label="对比历史 Run"
            value={compareId}
            onChange={(event) => setCompareId(event.target.value)}
          >
            <option value="">不对比</option>
            {runs
              .filter((run) => run.id !== selectedId)
              .map((run) => (
                <option key={run.id} value={run.id}>
                  第 {run.attempt} 次 · {statusZh(run.status)}
                </option>
              ))}
          </SelectField>
        </Field>
      ) : null}

      <Notice>{notice}</Notice>

      <div className={`grid gap-4 ${compared ? "lg:grid-cols-2" : ""}`}>
        {selected ? (
          <Timeline
            run={selected}
            serviceUrl={serviceUrl}
            onRunChange={replaceRun}
            onNotice={setNotice}
            onTodoChange={onTodoChange}
            onContinueGo={() => void continueGo()}
            canContinue={canContinue && !busy}
          />
        ) : null}
        {compared ? (
          <Timeline
            run={compared}
            serviceUrl={serviceUrl}
            onRunChange={replaceRun}
            onNotice={setNotice}
            readOnly
          />
        ) : null}
      </div>
    </Panel>
  );
}

function Timeline({
  run,
  serviceUrl,
  onRunChange,
  onNotice,
  onTodoChange,
  readOnly = false,
  onContinueGo,
  canContinue = false
}: {
  run: RunRecord;
  serviceUrl: string;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  onTodoChange?(todo: TodoRecord): void;
  readOnly?: boolean;
  onContinueGo?(): void;
  canContinue?: boolean;
}) {
  return (
    <Stack className="rounded-xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>第 {run.attempt} 次 Run</strong>
        <Tag>{statusZh(run.status)}</Tag>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="计划" value={run.planVersions.length} />
        <Stat label="日志" value={run.logs.length} />
        <Stat label="审查" value={run.reviews.length} />
        <Stat label="成果" value={run.artifacts.length} />
        <Stat label="检查点" value={run.checkpoints?.length ?? 0} />
      </div>

      {!readOnly && canContinue ? (
        <PrimaryButton type="button" onPress={onContinueGo}>
          确认并构建（Confirm to build）
        </PrimaryButton>
      ) : null}

      {/* Core: plan steps → multi-agent dispatch */}
      <AgentDispatchPanel serviceUrl={serviceUrl} run={run} onNotice={onNotice} />

      {/* Must answer when agent is blocked */}
      <AskUserPanel
        serviceUrl={serviceUrl}
        run={run}
        onRunChange={onRunChange}
        onNotice={onNotice}
        readOnly={readOnly}
      />

      {/* Advanced controls collapsed — default path is auto multi-agent */}
      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-muted">
          高级：手动批准 / DAG 调试 / 角色 / 审查
        </summary>
        <Stack className="mt-3">
          <PlanningApprovalPanel
            serviceUrl={serviceUrl}
            run={run}
            onRunChange={onRunChange}
            onNotice={onNotice}
            readOnly={readOnly}
          />
          {!readOnly ? (
            <SubtaskDagPanel
              serviceUrl={serviceUrl}
              available={!readOnly}
              runId={run.id}
              onNotice={onNotice}
            />
          ) : null}
          {!readOnly && run.planning?.approvalStatus === "approved" ? (
            <ProfessionalAgentPanel
              serviceUrl={serviceUrl}
              run={run}
              onRunChange={onRunChange}
              onNotice={onNotice}
            />
          ) : null}
          {!readOnly &&
          run.planning?.approvalStatus === "approved" &&
          (run.execution.status === "idle" ||
            run.execution.selectedAgent?.harness === "codex-cli") ? (
            <CodexHarnessPanel
              serviceUrl={serviceUrl}
              run={run}
              onRunChange={onRunChange}
              onNotice={onNotice}
            />
          ) : null}
          {!readOnly ? (
            <GitWorktreePanel serviceUrl={serviceUrl} run={run} onNotice={onNotice} />
          ) : null}
          <CheckpointRecoveryPanel
            serviceUrl={serviceUrl}
            run={run}
            onRunChange={onRunChange}
            onNotice={onNotice}
            readOnly={readOnly}
          />
          <ReviewPanel
            serviceUrl={serviceUrl}
            run={run}
            onRunChange={onRunChange}
            onNotice={onNotice}
            onTodoChange={onTodoChange}
            readOnly={readOnly}
          />
        </Stack>
      </details>

      {run.artifacts.length > 0 ? (
        <Stack>
          <strong>Artifacts</strong>
          {run.artifacts.map((artifact) => (
            <ListCard key={artifact.id}>
              <Tag>{artifact.kind}</Tag>
              <p className="m-0 text-sm">{artifact.path}</p>
            </ListCard>
          ))}
        </Stack>
      ) : null}

      {run.logs.length > 0 ? (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            日志（{run.logs.length}）
          </summary>
          <Stack className="mt-3">
            {run.logs.slice(-200).map((log) => (
              <ListCard key={log.id}>
                <Tag>{log.level}</Tag>
                <p className="m-0 text-sm">{log.message}</p>
              </ListCard>
            ))}
            {run.logs.length > 200 ? <EmptyHint>仅显示最近 200 条。</EmptyHint> : null}
          </Stack>
        </details>
      ) : null}

      <Divider />

      <Stack>
        <strong>时间线</strong>
        {run.timeline.length === 0 ? <EmptyHint>暂无事件</EmptyHint> : null}
        {run.timeline.map((event) => (
          <ListCard key={event.id}>
            <Tag>{event.kind}</Tag>
            <p className="m-0 text-sm">{event.summary}</p>
            <time className="text-xs text-muted">
              {new Date(event.createdAt).toLocaleString()}
            </time>
          </ListCard>
        ))}
      </Stack>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-field px-3 py-2 text-center">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
