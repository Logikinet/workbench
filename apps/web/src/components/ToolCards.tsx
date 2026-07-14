import type {
  AcceptanceCardPayload,
  AskCardPayload,
  SessionCardRecord,
  ToolCardPayload
} from "../lib/sessions.js";

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
    <div className="tool-cards" role="log" aria-label="会话卡片时间线">
      {hiddenOlder > 0 && (
        <p className="tool-cards-virtual-hint">
          已折叠较早 {hiddenOlder} 张卡片（按需加载 / 虚拟化窗口 {viewportLimit}）
        </p>
      )}
      {visible.map((card) => (
        <article key={card.id} className={`session-card session-card-${card.kind}`} data-sequence={card.sequence}>
          <header className="session-card-header">
            <span className="tag">{kindLabels[card.kind]}</span>
            <small>#{card.sequence}</small>
            {(card.kind === "tool_call" || card.logBody || (card.text && card.text.length > 200)) && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => onToggleCollapse?.(card)}
              >
                {card.collapsed ? "展开" : "折叠"}
              </button>
            )}
          </header>

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
            <div className="session-card-body">
              <strong>{card.artifact.path}</strong>
              <span>{card.artifact.kind}</span>
              {card.artifact.summary && <p>{card.artifact.summary}</p>}
            </div>
          ) : (
            <div className="session-card-body">
              {card.collapsed ? (
                <p className="session-card-summary">{card.summary}</p>
              ) : (
                <pre className="session-card-text">{card.text ?? card.summary}</pre>
              )}
              {card.logTruncated && <small>日志已截断，完整内容按需加载。</small>}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function ToolCardView({ tool, collapsed }: { tool: ToolCardPayload; collapsed: boolean }) {
  return (
    <div className={`tool-card tool-card-${tool.status}`} aria-label={`工具 ${tool.toolName}`}>
      <div className="tool-card-title-row">
        <strong>{tool.title || tool.toolName}</strong>
        <span className="tag">{tool.status}</span>
        <span className="tag">{tool.permission}</span>
        {tool.durationMs !== undefined && <small>{formatDuration(tool.durationMs)}</small>}
      </div>
      <p className="tool-card-args">
        <span>参数</span> {tool.argumentsSummary}
      </p>
      {!collapsed && (
        <>
          {tool.outputSummary && (
            <p className="tool-card-output">
              <span>输出</span> {tool.outputSummary}
            </p>
          )}
          {tool.artifactLinks.length > 0 && (
            <ul className="tool-card-links">
              {tool.artifactLinks.map((link) => (
                <li key={link.path}>
                  Artifact: <code>{link.path}</code>
                  {link.summary ? ` — ${link.summary}` : ""}
                </li>
              ))}
            </ul>
          )}
          {tool.evidenceLinks.length > 0 && (
            <ul className="tool-card-links">
              {tool.evidenceLinks.map((link) => (
                <li key={link.id}>
                  Evidence: {link.summary}
                  {link.path ? ` (${link.path})` : ""}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {collapsed && <p className="session-card-summary">{tool.outputSummary ?? tool.argumentsSummary}</p>}
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
    <div className="ask-card-inline">
      <p>{ask.prompt}</p>
      {ask.reason && <small>{ask.reason}</small>}
      {ask.status === "answered" && <p className="notice">已回答：{ask.answerSummary}</p>}
      {pending && kind === "ask_approval" && (
        <div className="session-card-actions">
          <button type="button" onClick={() => onAnswer({ approved: true })}>批准</button>
          <button type="button" className="danger-button" onClick={() => onAnswer({ approved: false })}>
            拒绝
          </button>
        </div>
      )}
      {pending && kind !== "ask_approval" && (
        <AskFreeform
          options={ask.options}
          onSubmit={(payload) => onAnswer(payload)}
        />
      )}
    </div>
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
    <form
      className="session-card-actions"
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
        <label key={option.id} className="inline-check">
          <input type="checkbox" name="opt" value={option.id} />
          {option.label}
        </label>
      ))}
      <textarea name="freeText" rows={2} placeholder="补充说明（可选）" />
      <button type="submit">提交回答</button>
    </form>
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
    <div className="acceptance-card-inline">
      <p>{acceptance.summary}</p>
      {acceptance.criteria && acceptance.criteria.length > 0 && (
        <ul>
          {acceptance.criteria.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {acceptance.status !== "pending" && (
        <p className="notice">
          {acceptance.status === "accepted" ? "已验收" : "已拒绝"}
          {acceptance.decisionNote ? `：${acceptance.decisionNote}` : ""}
        </p>
      )}
      {acceptance.status === "pending" && !readOnly && (
        <div className="session-card-actions">
          <button type="button" onClick={() => onAnswer({ approved: true })}>通过验收</button>
          <button type="button" className="danger-button" onClick={() => onAnswer({ approved: false })}>
            拒绝验收
          </button>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
