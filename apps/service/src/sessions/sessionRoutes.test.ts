import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionService } from "./sessionService.js";
import { createSessionRouteApp } from "./sessionRoutes.js";

describe("session routes", () => {
  let sessions: SessionService;
  let app: Awaited<ReturnType<typeof createSessionRouteApp>>;

  beforeEach(async () => {
    sessions = await SessionService.createMemory();
    app = await createSessionRouteApp({ sessions });
  });

  it("creates, lists with filters, gets, patches, clears, and deletes", async () => {
    const created = await request(app)
      .post("/api/sessions")
      .send({
        title: "Route session",
        projectId: "proj-1",
        agentRoleId: "role-1",
        preferredModelId: "model-x",
        tags: ["ui", "tools"],
        initialMessage: "hello session"
      })
      .expect(201);

    expect(created.body.id).toBeTruthy();
    expect(created.body.tags).toEqual(["ui", "tools"]);
    expect(created.body.preferredModelId).toBe("model-x");
    expect(created.body.cards[0].kind).toBe("user_message");

    const listed = await request(app).get("/api/sessions?tag=ui&projectId=proj-1").expect(200);
    expect(listed.body.sessions).toHaveLength(1);

    const detail = await request(app).get(`/api/sessions/${created.body.id}`).expect(200);
    expect(detail.body.title).toBe("Route session");

    const patched = await request(app)
      .patch(`/api/sessions/${created.body.id}`)
      .send({ tags: ["ui", "v2"], preferredModelId: "model-y" })
      .expect(200);
    expect(patched.body.preferredModelId).toBe("model-y");
    expect(patched.body.tags).toEqual(["ui", "v2"]);

    const cleared = await request(app).post(`/api/sessions/${created.body.id}/clear`).expect(200);
    expect(cleared.body.cards).toEqual([]);

    await request(app).delete(`/api/sessions/${created.body.id}`).expect(200);
    await request(app).get(`/api/sessions/${created.body.id}`).expect(404);
  });

  it("ingests events into tool cards and pages cards", async () => {
    const created = await request(app).post("/api/sessions").send({ title: "events" }).expect(201);
    const id = created.body.id as string;

    const ingested = await request(app)
      .post(`/api/sessions/${id}/events`)
      .send({
        events: [
          { kind: "stream_start", turnId: "t1" },
          { kind: "text_delta", text: "Working…", turnId: "t1" },
          {
            kind: "tool_request",
            toolCallId: "tc-1",
            toolName: "read_file",
            arguments: { path: "a.ts" },
            turnId: "t1"
          },
          {
            kind: "tool_result",
            toolCallId: "tc-1",
            ok: true,
            resultSummary: "done",
            artifacts: [{ path: "a.ts", kind: "file" }],
            turnId: "t1"
          },
          { kind: "ask_user", prompt: "OK?", options: [{ id: "y", label: "Yes" }], turnId: "t1" }
        ]
      })
      .expect(200);

    expect(ingested.body.status).toBe("waiting_for_user");
    expect(ingested.body.cards.some((card: { kind: string }) => card.kind === "tool_call")).toBe(true);

    const cards = await request(app).get(`/api/sessions/${id}/cards?limit=10&compact=true`).expect(200);
    expect(cards.body.total).toBeGreaterThan(0);
    expect(Array.isArray(cards.body.cards)).toBe(true);
  });

  it("queues messages during streaming and answers interactions", async () => {
    const created = await request(app).post("/api/sessions").send({ title: "queue" }).expect(201);
    const id = created.body.id as string;

    await request(app)
      .post(`/api/sessions/${id}/events`)
      .send({ events: [{ kind: "stream_start" }] })
      .expect(200);

    const queued = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .send({ content: "while streaming", mode: "queue" })
      .expect(201);
    expect(queued.body.messageQueue).toHaveLength(1);

    await request(app)
      .post(`/api/sessions/${id}/events`)
      .send({
        events: [
          { kind: "stream_end" },
          { kind: "ask_approval", summary: "write file?" }
        ]
      })
      .expect(200);

    const drained = await request(app).post(`/api/sessions/${id}/queue/drain`).expect(200);
    expect(drained.body.drained).toHaveLength(1);

    const session = await request(app).get(`/api/sessions/${id}`).expect(200);
    const askCard = session.body.cards.find((card: { kind: string }) => card.kind === "ask_approval");
    expect(askCard).toBeTruthy();

    const answered = await request(app)
      .post(`/api/sessions/${id}/cards/${askCard.id}/answer`)
      .send({ approved: true })
      .expect(200);
    expect(answered.body.cards.find((card: { id: string }) => card.id === askCard.id).ask.status).toBe(
      "answered"
    );
  });

  it("collapses cards and turns", async () => {
    const created = await request(app).post("/api/sessions").send({ title: "collapse" }).expect(201);
    const id = created.body.id as string;
    const ingested = await request(app)
      .post(`/api/sessions/${id}/events`)
      .send({
        events: [
          { kind: "text_delta", text: "a", turnId: "turn-z" },
          { kind: "tool_request", toolCallId: "t", toolName: "shell", turnId: "turn-z" }
        ]
      })
      .expect(200);

    const toolCard = ingested.body.cards.find((card: { kind: string }) => card.kind === "tool_call");
    const collapsed = await request(app)
      .post(`/api/sessions/${id}/cards/${toolCard.id}/collapse`)
      .send({ collapsed: true })
      .expect(200);
    expect(collapsed.body.cards.find((card: { id: string }) => card.id === toolCard.id).collapsed).toBe(
      true
    );

    const turn = await request(app)
      .post(`/api/sessions/${id}/turns/turn-z/collapse`)
      .send({ collapsed: true })
      .expect(200);
    expect(turn.body.cards.filter((card: { turnId: string }) => card.turnId === "turn-z").every(
      (card: { collapsed: boolean }) => card.collapsed
    )).toBe(true);
  });
});
