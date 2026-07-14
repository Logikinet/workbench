import { useEffect, useMemo, useState } from "react";
import { createRunClient, type RunRecord, type TaskType } from "../lib/runs.js";

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

export function PlanningApprovalPanel({ serviceUrl, run, onRunChange, onNotice, readOnly = false }: PlanningApprovalPanelProps) {
  const client = createRunClient(serviceUrl);
  const [taskType, setTaskType] = useState<TaskType>(run.planning?.assessment.taskType ?? "other");
  const [capabilities, setCapabilities] = useState(run.planning?.assessment.requiredCapabilities.join(", ") ?? "workspace");
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
    () => commandRows.filter((row) => row.enabled && row.text.trim()).map((row) => parseCommandLine(row.text)).filter((command) => command.length > 0),
    [commandRows]
  );

  const latestPlan = run.planVersions.at(-1);

  const updatePlanning = async () => {
    const requiredCapabilities = capabilities.split(",").map((value) => value.trim()).filter(Boolean);
    try {
      let changed: RunRecord;
      try {
        // Dedicated verification route persists commands + planning fields when mounted.
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
      onNotice(changed.planning?.assessment.criticalInputs.length ? "Firstmate 仍在等待关键输入。" : "Firstmate 识别已更新；验证命令已写入计划草稿。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法更新计划识别"); }
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
      // Persist current verification edits before approval so they bind to the plan version.
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
      onNotice(decision === "approved" ? "计划已批准；验证命令已绑定批准版本，尚未启动正式执行。" : decision === "returned" ? "已退回，Secondmate 已生成下一版计划。" : "计划已取消，未启动执行。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法记录计划决定"); }
  };

  const toggleCommand = (index: number) => {
    setCommandRows((rows) => rows.map((row, i) => i === index ? { ...row, enabled: !row.enabled } : row));
  };

  const editCommand = (index: number, text: string) => {
    setCommandRows((rows) => rows.map((row, i) => i === index ? { ...row, text } : row));
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
  return <section className="planning-panel" aria-label="Firstmate 与 Secondmate 计划审批">
    <header><p className="eyebrow">PLAN APPROVAL</p><h4>Firstmate 识别与 Secondmate 计划</h4></header>
    {!readOnly && <div className="planning-edit-grid">
      <label>主要任务类型<select aria-label="主要任务类型" value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)}>{Object.entries(taskTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>所需能力（逗号分隔）<input aria-label="所需能力" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></label>
      <label className="planning-wide">补充关键输入或更正上下文<textarea aria-label="补充计划上下文" placeholder="仅在需要补充关键结果或调整范围时填写" value={context} onChange={(event) => setContext(event.target.value)} /></label>
    </div>}
    {!readOnly && <button type="button" className="quiet-button" onClick={() => void updatePlanning()}>{planning ? "更新识别并生成新计划" : "开始识别并生成计划"}</button>}
    {planning && <>
      <div className="planning-summary"><span className={`tag ${planning.approvalStatus === "approved" ? "active" : "archived"}`}>{planning.approvalStatus}</span><span>复杂度：{planning.assessment.complexity}</span><span>能力：{planning.assessment.requiredCapabilities.join("、") || "无"}</span></div>
      {planning.assessment.rationale && <p className="notice">Firstmate 识别说明：{planning.assessment.rationale}</p>}
      {planning.assessment.criticalInputs.length > 0 && <p className="notice">Firstmate 仅因关键输入暂停：{planning.assessment.criticalInputs.join("；")}</p>}
      {planning.assessment.evidenceGaps && planning.assessment.evidenceGaps.length > 0 && <p className="notice">证据缺口：{planning.assessment.evidenceGaps.join("；")}</p>}
      <div className="planning-details"><div><strong>明确假设</strong><ul>{planning.assessment.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div><div><strong>禁止项</strong><ul>{(run.planVersions.at(-1)?.prohibitions ?? []).map((prohibition) => <li key={prohibition}>{prohibition}</li>)}</ul></div></div>
      {planning.assessment.contextUsage && <details className="planning-context-usage"><summary>规划上下文使用记录</summary><ul>
        {(planning.assessment.contextUsage.projectFacts ?? []).map((fact) => <li key={`fact-${fact}`}>项目事实：{fact}</li>)}
        {(planning.assessment.contextUsage.files ?? []).map((file) => <li key={`file-${file}`}>文件：{file}</li>)}
        {planning.assessment.contextUsage.workspaceSummary && <li>工作区摘要：{planning.assessment.contextUsage.workspaceSummary}</li>}
        {(planning.assessment.contextUsage.omittedBecauseUnnecessary ?? []).length > 0 && <li>未加载（非必要）：{(planning.assessment.contextUsage.omittedBecauseUnnecessary ?? []).join("、")}</li>}
      </ul></details>}
    </>}

    <div className="planning-verification" aria-label="项目感知验证方案">
      <header>
        <strong>验证方案</strong>
        <span className="muted"> 来自项目证据 / 用户指定 / 明确假设；批准后绑定计划版本</span>
      </header>
      {!readOnly && planning?.approvalStatus === "awaiting_approval" && (
        <div className="planning-verification-actions">
          <button type="button" className="quiet-button" onClick={() => void proposeVerification()}>按项目栈生成验证方案</button>
        </div>
      )}
      {commandRows.length === 0 && (
        <p className="notice">当前无自动化验证命令。可生成方案、手工补充，或使用下方手工检查清单（不会强制 npm test）。</p>
      )}
      <ul className="verification-command-list">
        {commandRows.map((row, index) => (
          <li key={`cmd-${index}`}>
            {!readOnly && planning?.approvalStatus !== "approved" ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`启用验证命令 ${index + 1}`}
                    checked={row.enabled}
                    onChange={() => toggleCommand(index)}
                  />
                  启用
                </label>
                <input
                  aria-label={`验证命令 ${index + 1}`}
                  value={row.text}
                  onChange={(event) => editCommand(index, event.target.value)}
                />
                <button type="button" className="quiet-button" onClick={() => removeCommand(index)}>移除</button>
              </>
            ) : (
              <code>{row.enabled ? row.text : `（已禁用）${row.text}`}</code>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && planning?.approvalStatus !== "approved" && (
        <div className="planning-verification-add">
          <input
            aria-label="补充验证命令"
            placeholder="补充命令，例如 pytest 或 npm run test:unit"
            value={newCommand}
            onChange={(event) => setNewCommand(event.target.value)}
          />
          <button type="button" className="quiet-button" onClick={addCommand}>补充命令</button>
        </div>
      )}
      {(manualNotes || (latestPlan?.verificationMethods?.length ?? 0) > 0) && (
        <div className="planning-manual-checklist">
          <strong>手工检查清单</strong>
          {manualNotes ? (
            <pre className="notice">{manualNotes}</pre>
          ) : (
            <ul>{latestPlan?.verificationMethods?.map((method) => <li key={method}>{method}</li>)}</ul>
          )}
        </div>
      )}
      {planning?.approvalStatus === "approved" && (
        <p className="notice">已批准验证命令绑定 v{planning.approvedPlanVersion}；执行阶段仅可运行这些命令，新增需重新审批。</p>
      )}
    </div>

    {run.planVersions.length > 0 && <ol className="plan-history">{run.planVersions.map((plan) => <li key={`${plan.version}-${plan.summary}`}><strong>v{plan.version} · {plan.summary}</strong>{plan.revisionNote && <p>退回说明：{plan.revisionNote}</p>}{plan.diffFromPrevious && <details className="plan-diff"><summary>相对 v{plan.diffFromPrevious.fromVersion} 的版本差异（{plan.diffFromPrevious.changedFieldCount} 项变更）</summary><ul>{plan.diffFromPrevious.summaryChanged && <li>摘要已更新</li>}{plan.diffFromPrevious.stepsAdded.map((item) => <li key={`sa-${item}`}>+ 步骤：{item}</li>)}{plan.diffFromPrevious.stepsRemoved.map((item) => <li key={`sr-${item}`}>− 步骤：{item}</li>)}{plan.diffFromPrevious.acceptanceAdded.map((item) => <li key={`aa-${item}`}>+ 验收：{item}</li>)}{plan.diffFromPrevious.acceptanceRemoved.map((item) => <li key={`ar-${item}`}>− 验收：{item}</li>)}{plan.diffFromPrevious.expectedArtifactsAdded.map((item) => <li key={`ea-${item}`}>+ Artifact：{item}</li>)}{plan.diffFromPrevious.expectedArtifactsRemoved.map((item) => <li key={`er-${item}`}>− Artifact：{item}</li>)}</ul></details>}<p>{plan.generatedBy === "secondmate" ? "Secondmate 生成" : "历史计划"}</p>{plan.verificationCommands && plan.verificationCommands.length > 0 && <p>验证命令：{plan.verificationCommands.map((command) => command.join(" ")).join("；")}</p>}{plan.steps && <details><summary>步骤、验收、风险与范围</summary><strong>步骤</strong><ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>{plan.dependencies && plan.dependencies.length > 0 && <><strong>依赖</strong><ul>{plan.dependencies.map((item) => <li key={item}>{item}</li>)}</ul></>}{plan.expectedArtifacts && plan.expectedArtifacts.length > 0 && <><strong>预期 Artifact</strong><ul>{plan.expectedArtifacts.map((item) => <li key={item}>{item}</li>)}</ul></>}{plan.allowedScope && plan.allowedScope.length > 0 && <><strong>允许范围</strong><ul>{plan.allowedScope.map((item) => <li key={item}>{item}</li>)}</ul></>}{plan.verificationMethods && plan.verificationMethods.length > 0 && <><strong>验证方法</strong><ul>{plan.verificationMethods.map((item) => <li key={item}>{item}</li>)}</ul></>}<strong>验收标准</strong><ul>{plan.acceptanceCriteria?.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul><strong>风险</strong><ul>{plan.risks?.map((risk) => <li key={risk}>{risk}</li>)}</ul></details>}</li>)}</ol>}
    {!readOnly && planning?.approvalStatus === "awaiting_approval" && <div className="plan-decisions"><textarea aria-label="计划反馈" placeholder="退回时说明修改要求（批准或取消可留空）" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} /><button type="button" onClick={() => void decide("approved")}>批准计划</button><button type="button" className="quiet-button" onClick={() => void decide("returned")}>退回修改</button><button type="button" className="quiet-button" onClick={() => void decide("cancelled")}>取消计划</button></div>}
    {planning?.approvalStatus === "approved" && <p className="notice">已批准 v{planning.approvedPlanVersion}；Firstmate 只负责后续编排，尚未执行正式任务。</p>}
  </section>;
}
