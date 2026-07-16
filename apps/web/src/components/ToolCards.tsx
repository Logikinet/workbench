import type {
  AcceptanceCardPayload,
  AskCardPayload,
  SessionCardRecord,
  ToolCardPayload
} from "../lib/sessions.js";
import {
  DangerButton,
  EmptyHint,
  FormBlock,
  ListCard,
  Notice,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  Tag
} from "./ui.js";

interface ToolCardsProps {
  cards: SessionCardRecord[];
  onToggleCollapse?(card: SessionCardRecord): void;
  onAnswer?(
    card: SessionCardRecord,
    payload: {
      selectedOptionIds?: string[];
      freeText?: string;
      approved?: boolean;
      decisionNote?: string;
    }
  ): void;
  readOnly?: boolean;
  /** Max visible cards before virtualization window (client-side slice). */
  viewportLimit?: number;
}

const kindLabels: Record<SessionCardRecord["kind"], string> = {
  user_message: "用户",
  agent_text: "Agent",
  tool_call: "Tool",
  ask_user: "AskUser",
  ask_approval: "AskApproval",
  ask_replan: "AskReplan",
  acceptance: "验收",
  artifact: "Artifact",
  system: "系统",
  queued_message: "排队"
};

/**
 * Ordered session timeline cards with structured Tool Cards.
 * Long bodies collapse; parent can load older pages for virtualization.
 */
export function ToolCards({
  cards,
  onToggleCollapse,
  onAnswer,
  readOnly = false,
  viewportLimit = 80
}: ToolCardsProps) {
  const visible = cards.length > viewportLimit ? cards.slice(cards.length - viewportLimit) : cards;
  const hiddenOlder = Math.max(0, cards.length - visible.length);

  return (
    <div className="grid gap-3" role="log" aria-label="会话卡片时间线">
      {hiddenOlder > 0 ? (
        <EmptyHint>
          已折叠较早 {hiddenOlder} 张卡片（按需加载 / 虚拟化窗口 {viewportLimit}）
        </EmptyHint>
      ) : null}
      {visible.map((card) => (
        <ListCard key={card.id} className="flex-col items-stretch">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Tag color="accent">{kindLabels[card.kind]}</Tag>
            <span className="text-xs text-muted">#{card.sequence}</span>
            {(card.kind === "tool_call" || card.logBody || (card.text && card.text.length > 200)) && (
              <QuietButton onPress={() => onToggleCollapse?.(card)}>
                {card.collapsed ? "展开" : "折叠"}
              </QuietButton>
            )}
          </div>

          {card.kind === "tool_call" && card.tool ? (
            <ToolCardView tool={card.tool} collapsed={card.collapsed} />
          ) : card.kind === "ask_user" || card.kind === "ask_approval" || card.kind === "ask_replan" ? (
            <AskCardView
              kind={card.kind}
              ask={card.ask}
              readOnly={readOnly}
              onAnswer={(payload) => onAnswer?.(card, payload)}
            />
          ) : card.kind === "acceptance" ? (
            <AcceptanceCardView
              acceptance={card.acceptance}
              readOnly={readOnly}
              onAnswer={(payload) => onAnswer?.(card, payload)}
            />
          ) : card.kind === "artifact" && card.artifact ? (
            <Stack>
              <strong>{card.artifact.path}</strong>
              <Tag>{card.artifact.kind}</Tag>
              {card.artifact.summary ? <p className="m-0 text-sm">{card.artifact.summary}</p> : null}
            </Stack>
          ) : (
            <Stack>
              {card.collapsed ? (
                <p className="m-0 text-sm text-muted">{card.summary}</p>
              ) : (
                <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-field p-3 text-sm">
                  {card.text ?? card.summary}
                </pre>
              )}
              {card.logTruncated ? <EmptyHint>日志已截断，完整内容按需加载。</EmptyHint> : null}
            </Stack>
          )}
        </ListCard>
      ))}
    </div>
  );
}

function ToolCardView({ tool, collapsed }: { tool: ToolCardPayload; collapsed: boolean }) {
  return (
    <div className="grid gap-3" aria-label={`工具 ${tool.toolName}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{tool.title || tool.toolName}</strong>
        <Tag color={tool.status === "failed" ? "danger" : tool.status === "completed" ? "success" : "default"}>
          {tool.status}
        </Tag>
        <Tag>{tool.permission}</Tag>
        {tool.durationMs !== undefined ? (
          <span className="text-xs text-muted">{formatDuration(tool.durationMs)}</span>
        ) : null}
      </div>
      <p className="m-0 text-sm">
        <span className="text-muted">参数 </span>
        {tool.argumentsSummary}
      </p>
      {!collapsed ? (
        <>
          {tool.outputSummary ? (
            <p className="m-0 text-sm">
              <span className="text-muted">输出 </span>
              {tool.outputSummary}
            </p>
          ) : null}
          {tool.artifactLinks.length > 0 ? (
            <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
              {tool.artifactLinks.map((link) => (
                <li key={link.path}>
                  Artifact: <code>{link.path}</code>
                  {link.summary ? ` — ${link.summary}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {tool.evidenceLinks.length > 0 ? (
            <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
              {tool.evidenceLinks.map((link) => (
                <li key={link.id}>
                  Evidence: {link.summary}
                  {link.path ? ` (${link.path})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {collapsed ? <EmptyHint>{tool.outputSummary ?? tool.argumentsSummary}</EmptyHint> : null}
    </div>
  );
}

function AskCardView({
  kind,
  ask,
  readOnly,
  onAnswer
}: {
  kind: "ask_user" | "ask_approval" | "ask_replan";
  ask?: AskCardPayload;
  readOnly: boolean;
  onAnswer(payload: { selectedOptionIds?: string[]; freeText?: string; approved?: boolean }): void;
}) {
  if (!ask) return null;
  const pending = ask.status === "pending" && !readOnly;

  return (
    <Stack>
      <p className="m-0 text-sm">{ask.prompt}</p>
      {ask.reason ? <EmptyHint>{ask.reason}</EmptyHint> : null}
      {ask.status === "answered" ? <Notice>已回答：{ask.answerSummary}</Notice> : null}
      {pending && kind === "ask_approval" ? (
        <RowActions>
          <PrimaryButton size="sm" onPress={() => onAnswer({ approved: true })}>
            批准
          </PrimaryButton>
          <DangerButton onPress={() => onAnswer({ approved: false })}>拒绝</DangerButton>
        </RowActions>
      ) : null}
      {pending && kind !== "ask_approval" ? (
        <AskFreeform options={ask.options} onSubmit={(payload) => onAnswer(payload)} />
      ) : null}
    </Stack>
  );
}

function AskFreeform({
  options,
  onSubmit
}: {
  options?: Array<{ id: string; label: string }>;
  onSubmit(payload: { selectedOptionIds?: string[]; freeText?: string }): void;
}) {
  return (
    <FormBlock
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const freeText = (form.elements.namedItem("freeText") as HTMLTextAreaElement | null)?.value ?? "";
        const selected = options
          ? Array.from(form.querySelectorAll<HTMLInputElement>("input[name=opt]:checked")).map((el) => el.value)
          : undefined;
        onSubmit({ freeText: freeText.trim() || undefined, selectedOptionIds: selected });
        form.reset();
      }}
    >
      {options?.map((option) => (
        <label key={option.id} className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" name="opt" value={option.id} />
          {option.label}
        </label>
      ))}
      <textarea
        name="freeText"
        rows={2}
        placeholder="补充说明（可选）"
        className="w-full min-h-24 rounded-lg border border-border bg-field px-3 py-2.5 text-sm text-foreground"
      />
      <PrimaryButton type="submit" size="sm">
        提交回答
      </PrimaryButton>
    </FormBlock>
  );
}

function AcceptanceCardView({
  acceptance,
  readOnly,
  onAnswer
}: {
  acceptance?: AcceptanceCardPayload;
  readOnly: boolean;
  onAnswer(payload: { approved?: boolean; decisionNote?: string }): void;
}) {
  if (!acceptance) return null;
  return (
    <Stack>
      <p className="m-0 text-sm">{acceptance.summary}</p>
      {acceptance.criteria && acceptance.criteria.length > 0 ? (
        <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
          {acceptance.criteria.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {acceptance.status !== "pending" ? (
        <Notice>
          {acceptance.status === "accepted" ? "已验收" : "已拒绝"}
          {acceptance.decisionNote ? `：${acceptance.decisionNote}` : ""}
        </Notice>
      ) : null}
      {acceptance.status === "pending" && !readOnly ? (
        <RowActions>
          <PrimaryButton size="sm" onPress={() => onAnswer({ approved: true })}>
            通过验收
          </PrimaryButton>
          <DangerButton onPress={() => onAnswer({ approved: false })}>拒绝验收</DangerButton>
        </RowActions>
      ) : null}
    </Stack>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
