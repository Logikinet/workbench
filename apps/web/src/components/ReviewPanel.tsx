import { useMemo, useState } from "react";
import { createRunClient, type RunRecord } from "../lib/runs.js";
import type { TodoRecord } from "../lib/todos.js";
import {
  EmptyHint,
  Field,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  Tag,
  TextAreaField
} from "./ui.js";

interface ReviewPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  onTodoChange?(todo: TodoRecord): void;
  readOnly?: boolean;
}

export function ReviewPanel({
  serviceUrl,
  run,
  onRunChange,
  onNotice,
  onTodoChange,
  readOnly = false
}: ReviewPanelProps) {
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
  const canAutoDispatchFix =
    gating?.status === "changes_requested" &&
    autoFixRemaining &&
    run.status !== "completed" &&
    run.execution.status !== "running";
  const canUserDispatchFix =
    ((gating?.status === "changes_requested" && !autoFixRemaining) ||
      (loop?.reworkRequested === true && run.status === "awaiting_acceptance")) &&
    run.status !== "completed" &&
    run.execution.status !== "running";

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
      onNotice(
        decision === "accepted"
          ? "用户已验收；Run 与 Todo 正式完成。"
          : "用户未接受；不得标记完成。可再次接受或授权返工修复。"
      );
      setSummary("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法记录验收决定");
    }
  };

  if (
    run.execution.status === "idle" &&
    run.reviews.length === 0 &&
    run.status !== "awaiting_review" &&
    run.status !== "awaiting_acceptance"
  ) {
    return null;
  }

  return (
    <Panel
      eyebrow="NO-MISTAKES REVIEW"
      title="独立审查与最终验收"
      description="Reviewer 使用独立上下文（目标、批准计划、验收标准、成果与证据），只输出结论，不修改成果。时间线备注审查不会开启验收。"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag color={gating?.status === "passed" ? "success" : "default"}>
          {gating ? `独立审查：${gating.status}` : "尚未独立审查"}
        </Tag>
        <span className="text-sm">
          自动修复：{loop?.autoFixCyclesUsed ?? 0}/{loop?.maxAutoFixCycles ?? 1}
        </span>
        {loop?.userAccepted === true ? <Tag color="success">用户已接受</Tag> : null}
        {loop?.userAccepted === false ? <Tag color="warning">用户未接受</Tag> : null}
        {loop?.reworkRequested ? <Tag color="accent">可授权返工</Tag> : null}
      </div>

      {latest ? (
        <Stack>
          <strong>{latest.summary}</strong>
          {latest.severity && latest.severity !== "none" ? (
            <EmptyHint>严重程度：{latest.severity}</EmptyHint>
          ) : null}
          {latest.fixScope ? <EmptyHint>修复范围：{latest.fixScope}</EmptyHint> : null}
          {latest.evidence && latest.evidence.length > 0 ? (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">审查证据</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {latest.evidence.map((item, index) => (
                  <li key={`evidence-${index}`}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {latest.findings && latest.findings.length > 0 ? (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">验收发现</summary>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
                {latest.findings.map((finding, index) => (
                  <li key={`finding-${index}`}>
                    <strong>{finding.met ? "通过" : "未通过"}</strong> · {finding.criterion}
                    <br />
                    <span className="text-muted">{finding.evidence}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Stack>
      ) : null}

      {!readOnly && canReview ? (
        <Stack>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoFix} onChange={(event) => setAutoFix(event.target.checked)} />
            失败时自动派发一次修复（默认最多 1 次）
          </label>
          <PrimaryButton onPress={() => void perform()}>启动独立审查</PrimaryButton>
        </Stack>
      ) : null}

      {!readOnly && canAutoDispatchFix && !canReview ? (
        <QuietButton onPress={() => void dispatchFix(false)}>派发自动修复</QuietButton>
      ) : null}

      {!readOnly && canUserDispatchFix ? (
        <QuietButton onPress={() => void dispatchFix(true)}>用户授权再次修复</QuietButton>
      ) : null}

      {!readOnly && canAccept ? (
        <Stack>
          <Field label="验收说明">
            <TextAreaField
              aria-label="验收说明"
              placeholder="验收说明（拒绝时必填）"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          <RowActions>
            <PrimaryButton onPress={() => void decide("accepted")}>接受并完成</PrimaryButton>
            <QuietButton onPress={() => void decide("rejected")}>拒绝验收</QuietButton>
          </RowActions>
        </Stack>
      ) : null}

      {run.status === "completed" ? (
        <Notice>审查通过且用户已验收；Run 与 Todo 已正式完成。</Notice>
      ) : null}
    </Panel>
  );
}
