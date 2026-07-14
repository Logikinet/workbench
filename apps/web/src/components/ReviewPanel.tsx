import { useMemo, useState } from "react";
import { createRunClient, type RunRecord } from "../lib/runs.js";
import type { TodoRecord } from "../lib/todos.js";

interface ReviewPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  onTodoChange?(todo: TodoRecord): void;
  readOnly?: boolean;
}

export function ReviewPanel({ serviceUrl, run, onRunChange, onNotice, onTodoChange, readOnly = false }: ReviewPanelProps) {
  const client = createRunClient(serviceUrl);
  const [summary, setSummary] = useState("");
  const [autoFix, setAutoFix] = useState(true);
  const loop = run.reviewLoop;
  const gating = useMemo(() => {
    if (!loop?.latestReviewId) return undefined;
    return run.reviews.find((review) => review.id === loop.latestReviewId && review.kind === "independent");
  }, [run.reviews, loop?.latestReviewId]);
  const latest = gating ?? run.reviews.filter((review) => review.kind === "independent").at(-1);
  const canReview = run.status === "awaiting_review" && run.execution.status === "succeeded";
  const canAccept = run.status === "awaiting_acceptance" && gating?.status === "passed" && !loop?.pendingFixInstruction;
  const autoFixRemaining = (loop?.autoFixCyclesUsed ?? 0) < (loop?.maxAutoFixCycles ?? 1);
  const canAutoDispatchFix = gating?.status === "changes_requested" && autoFixRemaining && run.status !== "completed" && run.execution.status !== "running";
  const canUserDispatchFix = (
    (gating?.status === "changes_requested" && !autoFixRemaining)
    || (loop?.reworkRequested === true && run.status === "awaiting_acceptance")
  ) && run.status !== "completed" && run.execution.status !== "running";

  const perform = async () => {
    try {
      const result = await client.performReview(run.id, { autoDispatchFix: autoFix });
      onRunChange(result.run);
      onNotice(
        result.review.status === "passed"
          ? "独立审查通过；请用户验收后才能标记完成。"
          : result.fixDispatched
            ? "审查未通过；Firstmate 已派发一次自动修复。"
            : "审查未通过；可派发修复或调整后复审。"
      );
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法执行独立审查");
    }
  };

  const dispatchFix = async (userAuthorized = false) => {
    try {
      const result = await client.dispatchReviewFix(run.id, { userAuthorized });
      onRunChange(result.run);
      if (result.continued) {
        onNotice(userAuthorized ? "用户授权修复已启动专业代理。" : "Firstmate 已派发修复并重启专业代理。");
      } else if (result.reason === "awaiting_write_session_approval") {
        onNotice("修复需要 Codex 写入会话确认后才会真正启动；自动修复次数未消耗。");
      } else {
        onNotice("修复指令已就绪；可重试专业代理。");
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法派发审查修复");
    }
  };

  const decide = async (decision: "accepted" | "rejected") => {
    const note = summary.trim() || (decision === "accepted" ? "用户接受成果。" : "");
    if (!note) {
      onNotice("拒绝验收时请说明原因。");
      return;
    }
    try {
      const result = await client.decideAcceptance(run.id, { decision, summary: note });
      onRunChange(result.run);
      onTodoChange?.(result.todo as TodoRecord);
      onNotice(decision === "accepted" ? "用户已验收；Run 与 Todo 正式完成。" : "用户未接受；不得标记完成。可再次接受或授权返工修复。");
      setSummary("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法记录验收决定");
    }
  };

  if (run.execution.status === "idle" && run.reviews.length === 0 && run.status !== "awaiting_review" && run.status !== "awaiting_acceptance") {
    return null;
  }

  return (
    <section className="review-panel" aria-label="独立审查与用户验收">
      <header>
        <p className="eyebrow">NO-MISTAKES REVIEW</p>
        <h4>独立审查与最终验收</h4>
      </header>
      <p>Reviewer 使用独立上下文（目标、批准计划、验收标准、成果与证据），只输出结论，不修改成果。时间线备注审查不会开启验收。</p>
      <div className="review-meta">
        <span className={`tag ${gating?.status === "passed" ? "active" : ""}`}>
          {gating ? `独立审查：${gating.status}` : "尚未独立审查"}
        </span>
        <span>自动修复：{loop?.autoFixCyclesUsed ?? 0}/{loop?.maxAutoFixCycles ?? 1}</span>
        {loop?.userAccepted === true && <span className="tag active">用户已接受</span>}
        {loop?.userAccepted === false && <span className="tag">用户未接受</span>}
        {loop?.reworkRequested && <span className="tag">可授权返工</span>}
      </div>
      {latest && (
        <div className="review-result">
          <strong>{latest.summary}</strong>
          {latest.severity && latest.severity !== "none" && <p>严重程度：{latest.severity}</p>}
          {latest.fixScope && <p>修复范围：{latest.fixScope}</p>}
          {latest.evidence && latest.evidence.length > 0 && (
            <details>
              <summary>审查证据</summary>
              <ul>{latest.evidence.map((item, index) => <li key={`evidence-${index}`}>{item}</li>)}</ul>
            </details>
          )}
          {latest.findings && latest.findings.length > 0 && (
            <details>
              <summary>验收发现</summary>
              <ul>
                {latest.findings.map((finding, index) => (
                  <li key={`finding-${index}`}>
                    <strong>{finding.met ? "通过" : "未通过"}</strong> · {finding.criterion}
                    <br />
                    <small>{finding.evidence}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {!readOnly && canReview && (
        <div className="review-actions">
          <label className="inline-check">
            <input type="checkbox" checked={autoFix} onChange={(event) => setAutoFix(event.target.checked)} />
            失败时自动派发一次修复（默认最多 1 次）
          </label>
          <button type="button" onClick={() => void perform()}>启动独立审查</button>
        </div>
      )}
      {!readOnly && canAutoDispatchFix && !canReview && (
        <button type="button" className="quiet-button" onClick={() => void dispatchFix(false)}>派发自动修复</button>
      )}
      {!readOnly && canUserDispatchFix && (
        <button type="button" className="quiet-button" onClick={() => void dispatchFix(true)}>用户授权再次修复</button>
      )}
      {!readOnly && canAccept && (
        <div className="acceptance-actions">
          <textarea
            aria-label="验收说明"
            placeholder="验收说明（拒绝时必填）"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <button type="button" onClick={() => void decide("accepted")}>接受并完成</button>
          <button type="button" className="quiet-button" onClick={() => void decide("rejected")}>拒绝验收</button>
        </div>
      )}
      {run.status === "completed" && <p className="notice">审查通过且用户已验收；Run 与 Todo 已正式完成。</p>}
    </section>
  );
}
