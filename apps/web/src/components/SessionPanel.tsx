import { useEffect, useMemo, useState } from "react";
import {
  createSessionClient,
  type AgentSessionRecord,
  type SessionCardRecord,
  type SessionStatus
} from "../lib/sessions.js";
import { ToolCards } from "./ToolCards.js";
import {
  DangerButton,
  Divider,
  EmptyHint,
  Field,
  FormBlock,
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

interface SessionPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  /** Optional defaults when creating a session from a Todo/Run context. */
  defaultProjectId?: string;
  defaultAgentRoleId?: string;
  defaultRunId?: string;
  defaultTodoId?: string;
}

const statusOptions: Array<{ value: "" | SessionStatus; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "idle", label: "idle" },
  { value: "streaming", label: "streaming" },
  { value: "waiting_for_user", label: "waiting_for_user" },
  { value: "completed", label: "completed" },
  { value: "failed", label: "failed" },
  { value: "cancelled", label: "cancelled" }
];

/**
 * Session list + structured Tool Card timeline (Task 41).
 * Input remains editable while streaming; messages queue or act as corrections.
 * Mount when sessions capability is wired on the service.
 */
export function SessionPanel({
  serviceUrl,
  available,
  dataEpoch = 0,
  defaultProjectId,
  defaultAgentRoleId,
  defaultRunId,
  defaultTodoId
}: SessionPanelProps) {
  const client = useMemo(() => createSessionClient(serviceUrl), [serviceUrl]);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [cards, setCards] = useState<SessionCardRecord[]>([]);
  const [cardsTotal, setCardsTotal] = useState(0);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [agentRoleId, setAgentRoleId] = useState(defaultAgentRoleId ?? "");
  const [status, setStatus] = useState<"" | SessionStatus>("");

  const [draft, setDraft] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newTags, setNewTags] = useState("");
  const [preferredModel, setPreferredModel] = useState("");
  const [sendMode, setSendMode] = useState<"queue" | "correction" | "force">("queue");

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId]
  );

  const reloadList = async () => {
    if (!available) return;
    try {
      const list = await client.list({
        q: q.trim() || undefined,
        tag: tag.trim() || undefined,
        projectId: projectId.trim() || undefined,
        agentRoleId: agentRoleId.trim() || undefined,
        status: status || undefined
      });
      setSessions(list);
      if (selectedId && !list.some((session) => session.id === selectedId)) {
        setSelectedId(list[0]?.id ?? "");
      } else if (!selectedId && list[0]) {
        setSelectedId(list[0].id);
      }
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载会话列表");
    }
  };

  const reloadCards = async (sessionId: string, opts?: { beforeSequence?: number; appendOlder?: boolean }) => {
    if (!sessionId) {
      setCards([]);
      return;
    }
    try {
      const page = await client.cards(sessionId, {
        limit: 40,
        compact: true,
        beforeSequence: opts?.beforeSequence
      });
      setCardsTotal(page.total);
      setHasMoreOlder(page.hasMoreOlder);
      setCards((current) => {
        if (opts?.appendOlder) {
          const merged = [...page.cards, ...current];
          const seen = new Set<string>();
          return merged.filter((card) => {
            if (seen.has(card.id)) return false;
            seen.add(card.id);
            return true;
          });
        }
        return page.cards;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载卡片");
    }
  };

  useEffect(() => {
    void reloadList();
  }, [available, dataEpoch, q, tag, projectId, agentRoleId, status]);

  useEffect(() => {
    if (!selectedId) {
      setCards([]);
      return;
    }
    void reloadCards(selectedId);
  }, [selectedId, dataEpoch]);

  // Poll lightly while streaming or waiting so timeline stays fresh.
  useEffect(() => {
    if (!selected || (selected.status !== "streaming" && selected.status !== "waiting_for_user")) {
      return;
    }
    const timer = window.setInterval(() => {
      void reloadList();
      void reloadCards(selected.id);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.status]);

  const createSession = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!available) return;
    setBusy(true);
    try {
      const created = await client.create({
        title: newTitle.trim() || undefined,
        tags: newTags
          .split(/[,，\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
        preferredModelId: preferredModel.trim() || undefined,
        projectId: projectId.trim() || defaultProjectId,
        agentRoleId: agentRoleId.trim() || defaultAgentRoleId,
        runId: defaultRunId,
        todoId: defaultTodoId,
        initialMessage: draft.trim() || undefined
      });
      setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
      setSelectedId(created.id);
      setCards(created.cards);
      setDraft("");
      setNewTitle("");
      setNotice("会话已创建。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建会话");
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    if (!selected || !draft.trim()) return;
    setBusy(true);
    try {
      const mode = selected.status === "streaming" ? sendMode : "force";
      const updated = await client.appendMessage(selected.id, draft.trim(), mode);
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
      setCards(updated.cards);
      setDraft("");
      setNotice(
        selected.status === "streaming" && mode !== "force"
          ? mode === "correction"
            ? "纠偏消息已排队。"
            : "消息已排队，流式结束后发送。"
          : "消息已发送。"
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法发送消息");
    } finally {
      setBusy(false);
    }
  };

  const saveSessionMeta = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await client.update(selected.id, {
        preferredModelId: preferredModel.trim() || null,
        tags: newTags
          .split(/[,，\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      });
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
      setNotice("会话标签 / 首选模型已更新（不影响全局 Agent Role）。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新会话");
    } finally {
      setBusy(false);
    }
  };

  const clearSession = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await client.clear(selected.id);
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
      setCards([]);
      setNotice("会话卡片已清空。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法清空会话");
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await client.remove(selected.id);
      setSessions((current) => current.filter((session) => session.id !== selected.id));
      setSelectedId("");
      setCards([]);
      setNotice("会话已删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法删除会话");
    } finally {
      setBusy(false);
    }
  };

  const loadOlder = async () => {
    if (!selected || cards.length === 0) return;
    const oldest = cards[0]!;
    await reloadCards(selected.id, { beforeSequence: oldest.sequence, appendOlder: true });
  };

  useEffect(() => {
    if (!selected) return;
    setPreferredModel(selected.preferredModelId ?? "");
    setNewTags(selected.tags.join(", "));
  }, [selected?.id]);

  return (
    <Panel
      eyebrow="AGENT SESSIONS"
      title="会话管理与 Tool Cards"
      actions={
        <QuietButton isDisabled={!available || busy} onPress={() => void reloadList()}>
          刷新
        </QuietButton>
      }
    >
      <Grid2>
        <Field label="搜索会话">
          <TextInput
            aria-label="搜索会话"
            placeholder="搜索标题 / 卡片摘要"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </Field>
        <Field label="标签筛选">
          <TextInput
            aria-label="标签筛选"
            placeholder="标签"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          />
        </Field>
        <Field label="Project ID">
          <TextInput
            aria-label="Project ID"
            placeholder="Project ID"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          />
        </Field>
        <Field label="Agent Role ID">
          <TextInput
            aria-label="Agent Role ID"
            placeholder="Agent Role ID"
            value={agentRoleId}
            onChange={(event) => setAgentRoleId(event.target.value)}
          />
        </Field>
        <Field label="状态筛选">
          <SelectField
            aria-label="状态筛选"
            value={status}
            onChange={(event) => setStatus(event.target.value as "" | SessionStatus)}
          >
            {statusOptions.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </Field>
      </Grid2>

      <FormBlock onSubmit={(event) => void createSession(event)}>
        <Grid2>
          <Field label="会话标题">
            <TextInput
              aria-label="会话标题"
              placeholder="新会话标题"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </Field>
          <Field label="标签">
            <TextInput
              aria-label="标签"
              placeholder="标签（逗号分隔）"
              value={newTags}
              onChange={(event) => setNewTags(event.target.value)}
            />
          </Field>
          <Field label="首选模型">
            <TextInput
              aria-label="首选模型"
              placeholder="会话首选模型（不改全局 Role）"
              value={preferredModel}
              onChange={(event) => setPreferredModel(event.target.value)}
            />
          </Field>
        </Grid2>
        <PrimaryButton type="submit" isDisabled={!available || busy}>
          新建会话
        </PrimaryButton>
      </FormBlock>

      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_1fr]">
        <Stack>
          <div className="visually-hidden" id="session-list-label">
            会话列表
          </div>
          {sessions.map((session) => (
            <ListCard
              key={session.id}
              className={session.id === selectedId ? "ring-2 ring-accent" : undefined}
              actions={
                <QuietButton onPress={() => setSelectedId(session.id)}>
                  {session.id === selectedId ? "已选中" : "打开"}
                </QuietButton>
              }
            >
              <button
                type="button"
                className="m-0 w-full border-0 bg-transparent p-0 text-left"
                onClick={() => setSelectedId(session.id)}
              >
                <strong>{session.title}</strong>
                <p className="m-0 text-sm text-muted">
                  {session.status} · {session.cardCount} cards
                </p>
                {session.tags.length > 0 ? (
                  <p className="m-0 text-xs text-muted">{session.tags.join(" · ")}</p>
                ) : null}
              </button>
            </ListCard>
          ))}
          {sessions.length === 0 && <EmptyHint>暂无会话</EmptyHint>}
        </Stack>

        <Stack>
          {selected ? (
            <>
              <ListCard
                actions={
                  <>
                    <QuietButton isDisabled={busy} onPress={() => void saveSessionMeta()}>
                      保存标签/模型
                    </QuietButton>
                    <QuietButton isDisabled={busy} onPress={() => void clearSession()}>
                      清空
                    </QuietButton>
                    <DangerButton isDisabled={busy} onPress={() => void deleteSession()}>
                      删除
                    </DangerButton>
                  </>
                }
              >
                <h3 className="m-0 text-base font-semibold">{selected.title}</h3>
                <p className="m-0 text-sm text-muted">
                  {selected.status}
                  {selected.preferredModelId ? ` · model ${selected.preferredModelId}` : ""}
                  {selected.agentName ? ` · ${selected.agentName}` : ""}
                </p>
                {selected.messageQueue.length > 0 && (
                  <Tag color="warning">排队中 {selected.messageQueue.length} 条消息</Tag>
                )}
              </ListCard>

              {hasMoreOlder && (
                <QuietButton onPress={() => void loadOlder()}>
                  加载更早卡片（{cards.length}/{cardsTotal}）
                </QuietButton>
              )}

              <ToolCards
                cards={cards}
                onToggleCollapse={(card) => {
                  void client.collapseCard(selected.id, card.id, !card.collapsed).then((updated) => {
                    setSessions((current) =>
                      current.map((session) => (session.id === updated.id ? updated : session))
                    );
                    setCards((current) =>
                      current.map((entry) =>
                        entry.id === card.id ? { ...entry, collapsed: !entry.collapsed } : entry
                      )
                    );
                  });
                }}
                onAnswer={(card, payload) => {
                  void client.answer(selected.id, card.id, payload).then((updated) => {
                    setSessions((current) =>
                      current.map((session) => (session.id === updated.id ? updated : session))
                    );
                    setCards(updated.cards);
                    setNotice("已提交回答。");
                  });
                }}
              />

              <Divider />

              <Stack>
                <Field label="会话输入">
                  <TextAreaField
                    aria-label="会话输入"
                    rows={3}
                    placeholder={
                      selected.status === "streaming"
                        ? "流式执行中仍可输入：将排队或作为纠偏"
                        : "输入消息…"
                    }
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={!available}
                  />
                </Field>
                {selected.status === "streaming" && (
                  <Field label="发送模式">
                    <SelectField
                      aria-label="发送模式"
                      value={sendMode}
                      onChange={(event) => setSendMode(event.target.value as typeof sendMode)}
                    >
                      <option value="queue">排队（结束后发送）</option>
                      <option value="correction">纠偏</option>
                      <option value="force">立即写入时间线</option>
                    </SelectField>
                  </Field>
                )}
                <RowActions>
                  <PrimaryButton
                    isDisabled={!available || busy || !draft.trim()}
                    onPress={() => void sendMessage()}
                  >
                    发送
                  </PrimaryButton>
                </RowActions>
              </Stack>
            </>
          ) : (
            <EmptyHint>选择或创建一个会话。</EmptyHint>
          )}
        </Stack>
      </div>

      {notice ? <Notice>{notice}</Notice> : null}
    </Panel>
  );
}
