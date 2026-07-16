import { useEffect, useMemo, useState } from "react";
import { createRunClient, type RunRecord, type TaskType } from "../lib/runs.js";
import {
  EmptyHint,
  Field,
  Grid2,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  SelectField,
  Stack,
  Tag,
  TextAreaField,
  TextInput
} from "./ui.js";

interface PlanningApprovalPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  readOnly?: boolean;
}

const taskTypeLabels: Record<TaskType, string> = {
  implementation: "实现功能",
  bug_fix: "修复问题",
  research: "调研",
  writing: "写作",
  analysis: "分析",
  automation: "自动化",
  other: "其他"
};

interface EditableCommandRow {
  text: string;
  enabled: boolean;
}

function commandsFromRun(run: RunRecord): EditableCommandRow[] {
  const latest = run.planVersions.at(-1)?.verificationCommands ?? run.planning?.verificationCommands ?? [];
  return latest.map((command) => ({ text: command.join(" "), enabled: true }));
}

function parseCommandLine(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function PlanningApprovalPanel({
  serviceUrl,
  run,
  onRunChange,
  onNotice,
  readOnly = false
}: PlanningApprovalPanelProps) {
  const client = createRunClient(serviceUrl);
  const [taskType, setTaskType] = useState<TaskType>(run.planning?.assessment.taskType ?? "other");
  const [capabilities, setCapabilities] = useState(
    run.planning?.assessment.requiredCapabilities.join(", ") ?? "workspace"
  );
  const [context, setContext] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [commandRows, setCommandRows] = useState<EditableCommandRow[]>(() => commandsFromRun(run));
  const [newCommand, setNewCommand] = useState("");
  const [manualNotes, setManualNotes] = useState("");

  useEffect(() => {
    setTaskType(run.planning?.assessment.taskType ?? "other");
    setCapabilities(run.planning?.assessment.requiredCapabilities.join(", ") ?? "workspace");
    setContext("");
    setDecisionNote("");
    setCommandRows(commandsFromRun(run));
    setNewCommand("");
  }, [run.id, run.updatedAt]);

  const enabledCommands = useMemo(
    () =>
      commandRows
        .filter((row) => row.enabled && row.text.trim())
        .map((row) => parseCommandLine(row.text))
        .filter((command) => command.length > 0),
    [commandRows]
  );

  const latestPlan = run.planVersions.at(-1);

  const updatePlanning = async () => {
    const requiredCapabilities = capabilities
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      let changed: RunRecord;
      try {
        changed = await client.updateVerification(run.id, {
          verificationCommands: enabledCommands,
          taskType,
          requiredCapabilities,
          additionalContext: context || undefined
        });
      } catch {
        changed = await client.updatePlanning(run.id, {
          taskType,
          requiredCapabilities,
          additionalContext: context || undefined,
          verificationCommands: enabledCommands
        });
      }
      onRunChange(changed);
      onNotice(
        changed.planning?.assessment.criticalInputs.length
          ? "Firstmate 仍在等待关键输入。"
          : "Firstmate 识别已更新；验证命令已写入计划草稿。"
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法更新计划识别");
    }
  };

  const proposeVerification = async () => {
    try {
      const plan = await client.proposeVerification(run.id, { taskType });
      const rows: EditableCommandRow[] = plan.commands.map((entry) => ({
        text: entry.command.join(" "),
        enabled: entry.enabled
      }));
      setCommandRows(rows);
      if (plan.manualChecklist.length > 0) {
        setManualNotes(plan.manualChecklist.map((item) => item.description).join("\n"));
      }
      const noticeParts = [
        `已根据项目栈（${plan.stack.primary}）生成验证方案`,
        plan.stack.hasAutomatedTests ? "检测到自动化测试线索" : "无自动化测试，请使用手工清单"
      ];
      if (plan.assumptions.length > 0) noticeParts.push(`假设 ${plan.assumptions.length} 条`);
      onNotice(noticeParts.join("；") + "。");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法生成项目感知验证方案（需挂载 verification 路由）");
    }
  };

  const decide = async (decision: "approved" | "returned" | "cancelled") => {
    const fallback = decision === "approved" ? "批准当前计划。" : decision === "cancelled" ? "取消当前计划。" : "";
    const summary = decisionNote.trim() || fallback;
    if (!summary) {
      onNotice("退回计划时请说明需要修改的内容。");
      return;
    }
    try {
      if (decision === "approved" && !readOnly) {
        try {
          await client.updateVerification(run.id, { verificationCommands: enabledCommands });
        } catch {
          try {
            await client.updatePlanning(run.id, { verificationCommands: enabledCommands });
          } catch {
            // If neither route accepts verificationCommands yet, still attempt decide;
            // server-side approved plan keeps prior commands.
          }
        }
      }
      const changed = await client.decidePlan(run.id, { decision, summary });
      onRunChange(changed);
      onNotice(
        decision === "approved"
          ? "计划已批准；Firstmate 将自动创建子任务并启动执行代理（验证命令已绑定批准版本）。"
          : decision === "returned"
            ? "已退回，Secondmate 已生成下一版计划。"
            : "计划已取消，未启动执行。"
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法记录计划决定");
    }
  };

  const toggleCommand = (index: number) => {
    setCommandRows((rows) => rows.map((row, i) => (i === index ? { ...row, enabled: !row.enabled } : row)));
  };

  const editCommand = (index: number, text: string) => {
    setCommandRows((rows) => rows.map((row, i) => (i === index ? { ...row, text } : row)));
  };

  const removeCommand = (index: number) => {
    setCommandRows((rows) => rows.filter((_, i) => i !== index));
  };

  const addCommand = () => {
    const text = newCommand.trim();
    if (!text) return;
    setCommandRows((rows) => [...rows, { text, enabled: true }]);
    setNewCommand("");
  };

  const planning = run.planning;

  return (
    <Panel eyebrow="PLAN APPROVAL" title="Firstmate 识别与 Secondmate 计划">
      {!readOnly ? (
        <Stack>
          <Grid2>
            <Field label="主要任务类型">
              <SelectField
                aria-label="主要任务类型"
                value={taskType}
                onChange={(event) => setTaskType(event.target.value as TaskType)}
              >
                {Object.entries(taskTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectField>
            </Field>
            <Field label="所需能力（逗号分隔）">
              <TextInput
                aria-label="所需能力"
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
              />
            </Field>
          </Grid2>
          <Field label="补充关键输入或更正上下文">
            <TextAreaField
              aria-label="补充计划上下文"
              placeholder="仅在需要补充关键结果或调整范围时填写"
              value={context}
              onChange={(event) => setContext(event.target.value)}
            />
          </Field>
          <QuietButton onPress={() => void updatePlanning()}>
            {planning ? "更新识别并生成新计划" : "开始识别并生成计划"}
          </QuietButton>
        </Stack>
      ) : null}

      {planning ? (
        <Stack>
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={planning.approvalStatus === "approved" ? "success" : "warning"}>
              {planning.approvalStatus}
            </Tag>
            <span className="text-sm">复杂度：{planning.assessment.complexity}</span>
            <span className="text-sm">
              能力：{planning.assessment.requiredCapabilities.join("、") || "无"}
            </span>
          </div>
          {planning.assessment.rationale ? (
            <Notice>Firstmate 识别说明：{planning.assessment.rationale}</Notice>
          ) : null}
          {planning.assessment.criticalInputs.length > 0 ? (
            <Notice tone="warning">
              Firstmate 仅因关键输入暂停：{planning.assessment.criticalInputs.join("；")}
            </Notice>
          ) : null}
          {planning.assessment.evidenceGaps && planning.assessment.evidenceGaps.length > 0 ? (
            <Notice tone="warning">证据缺口：{planning.assessment.evidenceGaps.join("；")}</Notice>
          ) : null}
          <Grid2>
            <div>
              <strong>明确假设</strong>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {planning.assessment.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            </div>
            <div>
              <strong>禁止项</strong>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {(run.planVersions.at(-1)?.prohibitions ?? []).map((prohibition) => (
                  <li key={prohibition}>{prohibition}</li>
                ))}
              </ul>
            </div>
          </Grid2>
          {planning.assessment.contextUsage ? (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">规划上下文使用记录</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {(planning.assessment.contextUsage.projectFacts ?? []).map((fact) => (
                  <li key={`fact-${fact}`}>项目事实：{fact}</li>
                ))}
                {(planning.assessment.contextUsage.files ?? []).map((file) => (
                  <li key={`file-${file}`}>文件：{file}</li>
                ))}
                {planning.assessment.contextUsage.workspaceSummary ? (
                  <li>工作区摘要：{planning.assessment.contextUsage.workspaceSummary}</li>
                ) : null}
                {(planning.assessment.contextUsage.omittedBecauseUnnecessary ?? []).length > 0 ? (
                  <li>
                    未加载（非必要）：
                    {(planning.assessment.contextUsage.omittedBecauseUnnecessary ?? []).join("、")}
                  </li>
                ) : null}
              </ul>
            </details>
          ) : null}
        </Stack>
      ) : null}

      <Stack>
        <div>
          <strong>验证方案</strong>
          <EmptyHint>来自项目证据 / 用户指定 / 明确假设；批准后绑定计划版本</EmptyHint>
        </div>
        {!readOnly && planning?.approvalStatus === "awaiting_approval" ? (
          <QuietButton onPress={() => void proposeVerification()}>按项目栈生成验证方案</QuietButton>
        ) : null}
        {commandRows.length === 0 ? (
          <Notice>
            当前无自动化验证命令。可生成方案、手工补充，或使用下方手工检查清单（不会强制 npm test）。
          </Notice>
        ) : null}
        <Stack>
          {commandRows.map((row, index) => (
            <ListCard
              key={`cmd-${index}`}
              actions={
                !readOnly && planning?.approvalStatus !== "approved" ? (
                  <QuietButton onPress={() => removeCommand(index)}>移除</QuietButton>
                ) : undefined
              }
            >
              {!readOnly && planning?.approvalStatus !== "approved" ? (
                <div className="grid gap-2">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`启用验证命令 ${index + 1}`}
                      checked={row.enabled}
                      onChange={() => toggleCommand(index)}
                    />
                    启用
                  </label>
                  <TextInput
                    aria-label={`验证命令 ${index + 1}`}
                    value={row.text}
                    onChange={(event) => editCommand(index, event.target.value)}
                  />
                </div>
              ) : (
                <code className="text-sm">{row.enabled ? row.text : `（已禁用）${row.text}`}</code>
              )}
            </ListCard>
          ))}
        </Stack>
        {!readOnly && planning?.approvalStatus !== "approved" ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="补充验证命令">
                <TextInput
                  aria-label="补充验证命令"
                  placeholder="补充命令，例如 pytest 或 npm run test:unit"
                  value={newCommand}
                  onChange={(event) => setNewCommand(event.target.value)}
                />
              </Field>
            </div>
            <QuietButton onPress={addCommand}>补充命令</QuietButton>
          </div>
        ) : null}
        {manualNotes || (latestPlan?.verificationMethods?.length ?? 0) > 0 ? (
          <div>
            <strong>手工检查清单</strong>
            {manualNotes ? (
              <pre className="mt-2 overflow-auto rounded-lg border border-border bg-field p-3 text-sm">
                {manualNotes}
              </pre>
            ) : (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {latestPlan?.verificationMethods?.map((method) => (
                  <li key={method}>{method}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {planning?.approvalStatus === "approved" ? (
          <Notice>
            已批准验证命令绑定 v{planning.approvedPlanVersion}；执行阶段仅可运行这些命令，新增需重新审批。
          </Notice>
        ) : null}
      </Stack>

      {run.planVersions.length > 0 ? (
        <Stack>
          <strong>计划历史</strong>
          {run.planVersions.map((plan) => (
            <ListCard key={`${plan.version}-${plan.summary}`}>
              <strong>
                v{plan.version} · {plan.summary}
              </strong>
              {plan.revisionNote ? <p className="m-0 text-sm">退回说明：{plan.revisionNote}</p> : null}
              {plan.diffFromPrevious ? (
                <details className="rounded-lg border border-border p-2">
                  <summary className="cursor-pointer text-sm">
                    相对 v{plan.diffFromPrevious.fromVersion} 的版本差异（
                    {plan.diffFromPrevious.changedFieldCount} 项变更）
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {plan.diffFromPrevious.summaryChanged ? <li>摘要已更新</li> : null}
                    {plan.diffFromPrevious.stepsAdded.map((item) => (
                      <li key={`sa-${item}`}>+ 步骤：{item}</li>
                    ))}
                    {plan.diffFromPrevious.stepsRemoved.map((item) => (
                      <li key={`sr-${item}`}>− 步骤：{item}</li>
                    ))}
                    {plan.diffFromPrevious.acceptanceAdded.map((item) => (
                      <li key={`aa-${item}`}>+ 验收：{item}</li>
                    ))}
                    {plan.diffFromPrevious.acceptanceRemoved.map((item) => (
                      <li key={`ar-${item}`}>− 验收：{item}</li>
                    ))}
                    {plan.diffFromPrevious.expectedArtifactsAdded.map((item) => (
                      <li key={`ea-${item}`}>+ Artifact：{item}</li>
                    ))}
                    {plan.diffFromPrevious.expectedArtifactsRemoved.map((item) => (
                      <li key={`er-${item}`}>− Artifact：{item}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <EmptyHint>{plan.generatedBy === "secondmate" ? "Secondmate 生成" : "历史计划"}</EmptyHint>
              {plan.verificationCommands && plan.verificationCommands.length > 0 ? (
                <EmptyHint>
                  验证命令：{plan.verificationCommands.map((command) => command.join(" ")).join("；")}
                </EmptyHint>
              ) : null}
              {plan.steps ? (
                <details className="rounded-lg border border-border p-2">
                  <summary className="cursor-pointer text-sm">步骤、验收、风险与范围</summary>
                  <div className="mt-2 space-y-2 text-sm">
                    <strong>步骤</strong>
                    <ol className="list-decimal space-y-1 pl-5">
                      {plan.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    {plan.dependencies && plan.dependencies.length > 0 ? (
                      <>
                        <strong>依赖</strong>
                        <ul className="list-disc space-y-1 pl-5">
                          {plan.dependencies.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {plan.expectedArtifacts && plan.expectedArtifacts.length > 0 ? (
                      <>
                        <strong>预期 Artifact</strong>
                        <ul className="list-disc space-y-1 pl-5">
                          {plan.expectedArtifacts.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {plan.allowedScope && plan.allowedScope.length > 0 ? (
                      <>
                        <strong>允许范围</strong>
                        <ul className="list-disc space-y-1 pl-5">
                          {plan.allowedScope.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {plan.verificationMethods && plan.verificationMethods.length > 0 ? (
                      <>
                        <strong>验证方法</strong>
                        <ul className="list-disc space-y-1 pl-5">
                          {plan.verificationMethods.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <strong>验收标准</strong>
                    <ul className="list-disc space-y-1 pl-5">
                      {plan.acceptanceCriteria?.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                    <strong>风险</strong>
                    <ul className="list-disc space-y-1 pl-5">
                      {plan.risks?.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : null}
            </ListCard>
          ))}
        </Stack>
      ) : null}

      {!readOnly && planning?.approvalStatus === "awaiting_approval" ? (
        <Stack>
          <Field label="计划反馈">
            <TextAreaField
              aria-label="计划反馈"
              placeholder="退回时说明修改要求（批准或取消可留空）"
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
            />
          </Field>
          <RowActions>
            <PrimaryButton onPress={() => void decide("approved")}>批准计划</PrimaryButton>
            <QuietButton onPress={() => void decide("returned")}>退回修改</QuietButton>
            <QuietButton onPress={() => void decide("cancelled")}>取消计划</QuietButton>
          </RowActions>
        </Stack>
      ) : null}

      {planning?.approvalStatus === "approved" ? (
        <Notice>
          已批准 v{planning.approvedPlanVersion}；Firstmate 只负责后续编排，尚未执行正式任务。
        </Notice>
      ) : null}
    </Panel>
  );
}
