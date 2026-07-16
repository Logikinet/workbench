import { useMemo, useState } from "react";
import {
  createRunClient,
  type AskUserRequestRecord,
  type RunRecord
} from "../lib/runs.js";
import {
  EmptyHint,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  Tag,
  TextAreaField
} from "./ui.js";

interface AskUserPanelProps {
  serviceUrl: string;
  run: RunRecord;
  onRunChange(run: RunRecord): void;
  onNotice(message: string): void;
  readOnly?: boolean;
}

const kindLabels: Record<AskUserRequestRecord["kind"], string> = {
  ask_user: "AskUser 澄清",
  ask_approval: "AskApproval 批准",
  ask_replan: "AskReplan 修订"
};

export function AskUserPanel({ serviceUrl, run, onRunChange, onNotice, readOnly = false }: AskUserPanelProps) {
  const client = createRunClient(serviceUrl);
  const requests = run.askUserRequests ?? [];
  const pending = useMemo(
    () => requests.filter((entry) => entry.status === "pending"),
    [requests]
  );
  const queued = useMemo(
    () => requests.filter((entry) => entry.status === "queued"),
    [requests]
  );

  if (requests.length === 0) return null;

  return (
    <Panel
      eyebrow="ASK USER"
      title="结构化澄清与批准"
      description="回答前不会继续消耗模型或执行后续步骤。"
    >
      {run.status === "waiting_for_user" ? (
        <Notice tone="warning">
          Run 处于 waiting_for_user：回答前不会继续消耗模型或执行后续步骤。重启后未回答问题仍会保留。
        </Notice>
      ) : null}

      <Stack>
        {pending.map((request) => (
          <AskUserCard
            key={request.id}
            request={request}
            readOnly={readOnly}
            onSubmit={async (payload) => {
              try {
                const changed = await client.answerAskUser(run.id, request.id, payload);
                onRunChange(changed);
                onNotice(
                  changed.status === "waiting_for_user"
                    ? "已回答；队列中仍有待处理问题。"
                    : "已回答并恢复原步骤。"
                );
              } catch (error) {
                onNotice(error instanceof Error ? error.message : "无法提交回答");
              }
            }}
          />
        ))}
      </Stack>

      {queued.length > 0 ? (
        <Stack>
          <strong>排队中（Firstmate 协调，避免重复打扰）</strong>
          {queued.map((request) => (
            <ListCard key={request.id}>
              <Tag color="accent">{kindLabels[request.kind]}</Tag>
              <p className="m-0 text-sm">{request.prompt}</p>
              <EmptyHint>
                来源 {request.source.agent} · 恢复 {request.source.stepKey}
              </EmptyHint>
            </ListCard>
          ))}
        </Stack>
      ) : null}

      {requests.some((entry) => entry.status === "answered") ? (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">已回答历史</summary>
          <Stack className="mt-3">
            {requests
              .filter((entry) => entry.status === "answered")
              .map((entry) => (
                <ListCard key={entry.id}>
                  <strong>
                    {kindLabels[entry.kind]}：{entry.prompt}
                  </strong>
                  <EmptyHint>
                    回答于 {entry.answeredAt ? new Date(entry.answeredAt).toLocaleString() : "—"}
                    {" · "}来源 {entry.source.agent} · 恢复 {entry.source.stepKey}
                  </EmptyHint>
                </ListCard>
              ))}
          </Stack>
        </details>
      ) : null}
    </Panel>
  );
}

function AskUserCard({
  request,
  readOnly,
  onSubmit
}: {
  request: AskUserRequestRecord;
  readOnly: boolean;
  onSubmit(payload: {
    selectedOptionIds?: string[];
    freeText?: string;
    approved?: boolean;
    replanFeedback?: string;
  }): Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = (id: string, multi: boolean) => {
    setSelected((current) => {
      if (multi) {
        return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      }
      return [id];
    });
  };

  const submit = async (extra: { approved?: boolean } = {}) => {
    setBusy(true);
    try {
      const payload = {
        selectedOptionIds: selected.length > 0 ? selected : undefined,
        freeText: freeText.trim() || undefined,
        approved: extra.approved,
        replanFeedback: request.kind === "ask_replan" ? (freeText.trim() || undefined) : undefined
      };
      await onSubmit(payload);
    } finally {
      setBusy(false);
    }
  };

  const multi = request.inputMode === "multi_select" || request.inputMode === "multi_select_with_text";
  const needsText =
    request.inputMode === "free_text" ||
    request.inputMode === "single_select_with_text" ||
    request.inputMode === "multi_select_with_text" ||
    request.kind === "ask_replan";
  const needsOptions = request.inputMode !== "free_text";

  return (
    <ListCard
      className="flex-col items-stretch"
      actions={
        !readOnly ? (
          <RowActions>
            {request.kind === "ask_approval" ? (
              <>
                <PrimaryButton size="sm" isDisabled={busy} onPress={() => void submit({ approved: true })}>
                  批准
                </PrimaryButton>
                <QuietButton isDisabled={busy} onPress={() => void submit({ approved: false })}>
                  拒绝
                </QuietButton>
              </>
            ) : (
              <PrimaryButton size="sm" isDisabled={busy} onPress={() => void submit()}>
                {request.kind === "ask_replan" ? "提交修订反馈" : "提交回答"}
              </PrimaryButton>
            )}
          </RowActions>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag color="accent">{kindLabels[request.kind]}</Tag>
        <span className="text-xs text-muted">来源：{request.source.label ?? request.source.agent}</span>
        <span className="text-xs text-muted">恢复位置：{request.source.stepKey}</span>
      </div>
      <p className="m-0 text-sm font-medium">{request.prompt}</p>
      <EmptyHint>原因：{request.reason}</EmptyHint>
      {request.recommendedAnswer ? (
        <Notice>
          推荐：{request.recommendedAnswer}
          {request.recommendationRationale ? `（${request.recommendationRationale}）` : ""}
        </Notice>
      ) : null}
      {needsOptions && request.options && request.options.length > 0 ? (
        <div className="grid gap-2" role="group" aria-label="选项">
          {request.options.map((option) => (
            <label key={option.id} className="inline-flex items-center gap-2 text-sm">
              <input
                type={multi ? "checkbox" : "radio"}
                name={`ask-${request.id}`}
                checked={selected.includes(option.id)}
                disabled={readOnly || busy}
                onChange={() => toggle(option.id, multi)}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
      {needsText ? (
        <TextAreaField
          aria-label={request.kind === "ask_replan" ? "修订反馈" : "自由输入"}
          placeholder={
            request.kind === "ask_replan"
              ? "说明需要如何修改计划…"
              : "请输入回答（必填校验由服务端执行）"
          }
          value={freeText}
          disabled={readOnly || busy}
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}
    </ListCard>
  );
}
