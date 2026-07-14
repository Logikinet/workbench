import { useEffect, useState } from "react";
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

export function PlanningApprovalPanel({ serviceUrl, run, onRunChange, onNotice, readOnly = false }: PlanningApprovalPanelProps) {
  const client = createRunClient(serviceUrl);
  const [taskType, setTaskType] = useState<TaskType>(run.planning?.assessment.taskType ?? "other");
  const [capabilities, setCapabilities] = useState(run.planning?.assessment.requiredCapabilities.join(", ") ?? "workspace");
  const [context, setContext] = useState("");
  const [decisionNote, setDecisionNote] = useState("");

  useEffect(() => {
    setTaskType(run.planning?.assessment.taskType ?? "other");
    setCapabilities(run.planning?.assessment.requiredCapabilities.join(", ") ?? "workspace");
    setContext("");
    setDecisionNote("");
  }, [run.id, run.updatedAt]);

  const updatePlanning = async () => {
    const requiredCapabilities = capabilities.split(",").map((value) => value.trim()).filter(Boolean);
    try {
      const changed = await client.updatePlanning(run.id, { taskType, requiredCapabilities, additionalContext: context || undefined });
      onRunChange(changed);
      onNotice(changed.planning?.assessment.criticalInputs.length ? "Firstmate 仍在等待关键输入。" : "Firstmate 识别已更新，Secondmate 已生成新计划版本。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法更新计划识别"); }
  };

  const decide = async (decision: "approved" | "returned" | "cancelled") => {
    const fallback = decision === "approved" ? "批准当前计划。" : decision === "cancelled" ? "取消当前计划。" : "";
    const summary = decisionNote.trim() || fallback;
    if (!summary) {
      onNotice("退回计划时请说明需要修改的内容。");
      return;
    }
    try {
      const changed = await client.decidePlan(run.id, { decision, summary });
      onRunChange(changed);
      onNotice(decision === "approved" ? "计划已批准；尚未启动正式执行。" : decision === "returned" ? "已退回，Secondmate 已生成下一版计划。" : "计划已取消，未启动执行。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法记录计划决定"); }
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
      {planning.assessment.criticalInputs.length > 0 && <p className="notice">Firstmate 仅因关键输入暂停：{planning.assessment.criticalInputs.join("；")}</p>}
      <div className="planning-details"><div><strong>明确假设</strong><ul>{planning.assessment.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div><div><strong>禁止项</strong><ul>{(run.planVersions.at(-1)?.prohibitions ?? []).map((prohibition) => <li key={prohibition}>{prohibition}</li>)}</ul></div></div>
    </>}
    {run.planVersions.length > 0 && <ol className="plan-history">{run.planVersions.map((plan) => <li key={`${plan.version}-${plan.summary}`}><strong>v{plan.version} · {plan.summary}</strong>{plan.revisionNote && <p>退回说明：{plan.revisionNote}</p>}<p>{plan.generatedBy === "secondmate" ? "Secondmate 生成" : "历史计划"}</p>{plan.steps && <details><summary>步骤、验收、风险</summary><strong>步骤</strong><ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol><strong>验收标准</strong><ul>{plan.acceptanceCriteria?.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul><strong>风险</strong><ul>{plan.risks?.map((risk) => <li key={risk}>{risk}</li>)}</ul></details>}</li>)}</ol>}
    {!readOnly && planning?.approvalStatus === "awaiting_approval" && <div className="plan-decisions"><textarea aria-label="计划反馈" placeholder="退回时说明修改要求（批准或取消可留空）" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} /><button type="button" onClick={() => void decide("approved")}>批准计划</button><button type="button" className="quiet-button" onClick={() => void decide("returned")}>退回修改</button><button type="button" className="quiet-button" onClick={() => void decide("cancelled")}>取消计划</button></div>}
    {planning?.approvalStatus === "approved" && <p className="notice">已批准 v{planning.approvedPlanVersion}；Firstmate 只负责后续编排，尚未执行正式任务。</p>}
  </section>;
}
