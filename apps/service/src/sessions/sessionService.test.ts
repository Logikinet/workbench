import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionService } from "./sessionService.js";

describe("SessionService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-sessions-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates sessions with tags, preferred model, and initial message", async () => {
    const sessions = await SessionService.createMemory();
    const created = await sessions.create({
      title: "实现 Tool Cards",
      projectId: "proj-1",
      agentRoleId: "role-api",
      agentName: "API Agent",
      preferredModelId: "gpt-test",
      tags: ["frontend", "tools", "frontend"],
      initialMessage: "请实现会话管理"
    });

    expect(created.tags).toEqual(["frontend", "tools"]);
    expect(created.preferredModelId).toBe("gpt-test");
    expect(created.agentRoleId).toBe("role-api");
    expect(created.status).toBe("idle");
    expect(created.cards).toHaveLength(1);
    expect(created.cards[0]?.kind).toBe("user_message");
    expect(created.cardCount).toBe(1);
  });

  it("filters by search, tag, project, agent, and status", async () => {
    const sessions = await SessionService.createMemory();
    await sessions.create({
      title: "Alpha 调研",
      projectId: "p1",
      agentRoleId: "a1",
      tags: ["research"],
      initialMessage: "收集证据"
    });
    const beta = await sessions.create({
      title: "Beta 实现",
      projectId: "p2",
      agentRoleId: "a2",
      tags: ["code"],
      initialMessage: "写代码"
    });
    await sessions.ingestEvents(beta.id, [{ kind: "stream_start" }, { kind: "text_delta", text: "working" }]);

    expect(sessions.list({ q: "证据" })).toHaveLength(1);
    expect(sessions.list({ tag: "code" }).map((s) => s.id)).toEqual([beta.id]);
    expect(sessions.list({ projectId: "p1" })).toHaveLength(1);
    expect(sessions.list({ agentRoleId: "a2" })).toHaveLength(1);
    expect(sessions.list({ status: "streaming" })).toHaveLength(1);
  });

  it("queues messages while streaming and drains them after", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({ initialMessage: "start" });
    await sessions.ingestEvents(session.id, [{ kind: "stream_start" }]);

    const queued = await sessions.appendMessage(session.id, {
      content: "follow-up while streaming",
      mode: "queue"
    });
    expect(queued.messageQueue).toHaveLength(1);
    expect(queued.cards.some((card) => card.kind === "queued_message")).toBe(true);

    const correction = await sessions.appendMessage(session.id, {
      content: "please pivot",
      mode: "correction"
    });
    expect(correction.messageQueue).toHaveLength(2);

    await sessions.ingestEvents(session.id, [{ kind: "stream_end" }]);
    const drained = await sessions.drainMessageQueue(session.id);
    expect(drained.drained).toHaveLength(2);
    expect(drained.session.messageQueue).toHaveLength(0);
    expect(drained.session.cards.filter((card) => card.kind === "user_message").length).toBeGreaterThanOrEqual(3);
  });

  it("folds runtime events into ordered turn cards with tool status and duration", async () => {
    let clock = Date.parse("2026-07-15T12:00:00.000Z");
    const sessions = await SessionService.createMemory({
      now: () => {
        const date = new Date(clock);
        clock += 500;
        return date;
      }
    });
    const session = await sessions.create({ title: "tool turn" });

    const updated = await sessions.ingestEvents(session.id, [
      { kind: "stream_start", turnId: "turn-1" },
      { kind: "text_delta", text: "I'll read the file.", turnId: "turn-1" },
      {
        kind: "tool_request",
        toolCallId: "tc-1",
        toolName: "read_file",
        arguments: { path: "README.md" },
        turnId: "turn-1"
      },
      {
        kind: "tool_result",
        toolCallId: "tc-1",
        ok: true,
        resultSummary: "ok content",
        artifacts: [{ path: "README.md", kind: "file", summary: "readme" }],
        evidence: [{ id: "ev-1", summary: "file exists" }],
        turnId: "turn-1"
      },
      {
        kind: "ask_user",
        prompt: "继续实现吗？",
        reason: "确认范围",
        options: [{ id: "yes", label: "是" }, { label: "否" }],
        turnId: "turn-1"
      }
    ]);

    expect(updated.status).toBe("waiting_for_user");
    expect(updated.pendingInteractionCardIds).toHaveLength(1);
    const kinds = updated.cards.map((card) => card.kind);
    expect(kinds).toContain("agent_text");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("ask_user");

    const tool = updated.cards.find((card) => card.kind === "tool_call")?.tool;
    expect(tool?.status).toBe("completed");
    expect(tool?.permission).toBe("readonly");
    expect(tool?.durationMs).toBeGreaterThanOrEqual(0);
    expect(tool?.artifactLinks[0]?.path).toBe("README.md");
    expect(tool?.evidenceLinks[0]?.id).toBe("ev-1");

    // Sequences are strictly ordered
    const sequences = updated.cards.map((card) => card.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("embeds AskApproval / AskReplan / acceptance and answers them", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({ title: "interactions" });
    let current = await sessions.ingestEvents(session.id, [
      { kind: "ask_approval", summary: "允许写入 src/a.ts", approvalKind: "write_file" },
      { kind: "ask_replan", prompt: "是否重规划？", reason: "范围变化" },
      { kind: "acceptance", summary: "请验收本轮改动", criteria: ["测试通过"] }
    ]);
    expect(current.status).toBe("waiting_for_user");
    expect(current.pendingInteractionCardIds.length).toBe(3);

    const approval = current.cards.find((card) => card.kind === "ask_approval")!;
    current = await sessions.answerInteraction(session.id, approval.id, { approved: true });
    expect(current.cards.find((card) => card.id === approval.id)?.ask?.status).toBe("answered");
    expect(current.pendingInteractionCardIds).toHaveLength(2);

    const replan = current.cards.find((card) => card.kind === "ask_replan")!;
    current = await sessions.answerInteraction(session.id, replan.id, {
      freeText: "缩小范围，只改 sessions"
    });
    expect(current.cards.find((card) => card.id === replan.id)?.ask?.answerSummary).toMatch(/缩小范围/);

    const acceptance = current.cards.find((card) => card.kind === "acceptance")!;
    current = await sessions.answerInteraction(session.id, acceptance.id, {
      approved: true,
      decisionNote: "LGTM"
    });
    expect(current.cards.find((card) => card.id === acceptance.id)?.acceptance?.status).toBe("accepted");
    expect(current.pendingInteractionCardIds).toHaveLength(0);
    expect(current.status).toBe("idle");
  });

  it("updates session tags and preferred model without affecting other sessions", async () => {
    const sessions = await SessionService.createMemory();
    const a = await sessions.create({ title: "A", preferredModelId: "m1", tags: ["x"] });
    const b = await sessions.create({ title: "B", preferredModelId: "m2", tags: ["y"] });

    const updated = await sessions.update(a.id, {
      preferredModelId: "m-session-only",
      tags: ["alpha", "beta"],
      agentName: "Local Agent"
    });
    expect(updated.preferredModelId).toBe("m-session-only");
    expect(updated.tags).toEqual(["alpha", "beta"]);
    expect(sessions.get(b.id).preferredModelId).toBe("m2");
  });

  it("clears and deletes sessions", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({ initialMessage: "hello" });
    await sessions.ingestEvents(session.id, [
      { kind: "text_delta", text: "world" },
      { kind: "complete", summary: "done" }
    ]);

    const cleared = await sessions.clear(session.id);
    expect(cleared.cards).toHaveLength(0);
    expect(cleared.status).toBe("idle");
    expect(cleared.cardCount).toBe(0);

    await sessions.delete(session.id);
    expect(() => sessions.get(session.id)).toThrow(/not found/i);
  });

  it("paginates cards and supports compact mode for virtualization", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({ title: "long" });
    const events = Array.from({ length: 30 }, (_, index) => ({
      kind: "text_delta" as const,
      text: `chunk-${index} `,
      turnId: `turn-${index}`
    }));
    await sessions.ingestEvents(session.id, events);

    const page = sessions.getCards(session.id, { limit: 10, compact: true });
    expect(page.cards.length).toBeLessThanOrEqual(10);
    expect(page.total).toBeGreaterThan(10);
    expect(page.hasMoreOlder).toBe(true);

    const older = sessions.getCards(session.id, {
      beforeSequence: page.cards[0]!.sequence,
      limit: 5
    });
    expect(older.cards.every((card) => card.sequence < page.cards[0]!.sequence)).toBe(true);
  });

  it("collapses individual cards and whole turns", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({ title: "collapse" });
    const updated = await sessions.ingestEvents(session.id, [
      { kind: "text_delta", text: "line1", turnId: "t1" },
      { kind: "tool_request", toolCallId: "tc", toolName: "shell", turnId: "t1" }
    ]);
    const toolCard = updated.cards.find((card) => card.kind === "tool_call")!;
    const collapsed = await sessions.setCardCollapsed(session.id, toolCard.id, true);
    expect(collapsed.cards.find((card) => card.id === toolCard.id)?.collapsed).toBe(true);

    const turnCollapsed = await sessions.collapseTurn(session.id, "t1", true);
    expect(turnCollapsed.cards.filter((card) => card.turnId === "t1").every((card) => card.collapsed)).toBe(
      true
    );
  });

  it("persists card order, pending asks, and status across reopen", async () => {
    const statePath = join(root, "sessions.json");
    const sessions = await SessionService.open(statePath);
    const created = await sessions.create({
      title: "durable",
      tags: ["persist"],
      preferredModelId: "local-model"
    });
    await sessions.ingestEvents(created.id, [
      { kind: "stream_start", turnId: "t1" },
      { kind: "tool_request", toolCallId: "tc-9", toolName: "shell", arguments: { cmd: "echo hi" }, turnId: "t1" },
      { kind: "tool_result", toolCallId: "tc-9", ok: true, resultSummary: "hi", turnId: "t1" },
      { kind: "ask_user", prompt: "继续？", turnId: "t1" }
    ]);

    const reopened = await SessionService.open(statePath);
    const restored = reopened.get(created.id);
    expect(restored.status).toBe("waiting_for_user");
    expect(restored.preferredModelId).toBe("local-model");
    expect(restored.tags).toEqual(["persist"]);
    expect(restored.pendingInteractionCardIds).toHaveLength(1);
    expect(restored.cards.map((card) => card.sequence)).toEqual(
      [...restored.cards].map((card) => card.sequence).sort((a, b) => a - b)
    );
    expect(restored.cards.some((card) => card.kind === "tool_call")).toBe(true);
    expect(restored.cards.some((card) => card.kind === "ask_user")).toBe(true);
  });

  it("redacts secrets in tool arguments and messages", async () => {
    const sessions = await SessionService.createMemory();
    const session = await sessions.create({
      initialMessage: "token=sk-abcdefghijklmnop"
    });
    expect(session.cards[0]?.text).not.toMatch(/sk-abcdefghijklmnop/);

    const withTool = await sessions.ingestEvents(session.id, [
      {
        kind: "tool_request",
        toolCallId: "tc-secret",
        toolName: "web",
        arguments: { authorization: "Bearer super-secret-token-value" }
      }
    ]);
    const tool = withTool.cards.find((card) => card.kind === "tool_call")?.tool;
    expect(JSON.stringify(tool?.arguments)).toMatch(/REDACTED/i);
    expect(tool?.argumentsSummary).not.toMatch(/super-secret-token-value/);
  });
});
