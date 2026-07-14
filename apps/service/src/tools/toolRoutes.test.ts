import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "./toolRegistry.js";
import { createToolRouteApp } from "./toolRoutes.js";

describe("tool routes", () => {
  let tools: ToolRegistry;
  let app: Awaited<ReturnType<typeof createToolRouteApp>>;

  beforeEach(async () => {
    tools = await ToolRegistry.createMemory();
    app = await createToolRouteApp({ tools });
  });

  it("lists tools and categories, registers, enables, disables, and trusts", async () => {
    const listed = await request(app).get("/api/tools").expect(200);
    expect(listed.body.tools.length).toBeGreaterThan(0);
    expect(listed.body.categories).toEqual(
      expect.arrayContaining(["readonly", "write", "shell", "network", "dangerous"])
    );

    const categories = await request(app).get("/api/tools/categories").expect(200);
    expect(categories.body.categories).toContain("shell");

    const created = await request(app)
      .post("/api/tools/register")
      .send({
        id: "route-tool",
        name: "route-tool",
        description: "From route test",
        category: "readonly",
        trusted: false
      })
      .expect(201);
    expect(created.body).toMatchObject({ id: "route-tool", trusted: false });

    await request(app).post("/api/tools/route-tool/disable").expect(200);
    expect((await tools.get("route-tool")).enabled).toBe(false);
    await request(app).post("/api/tools/route-tool/enable").expect(200);
    await request(app).post("/api/tools/route-tool/trust").expect(200);
    expect((await tools.get("route-tool")).trusted).toBe(true);

    const detail = await request(app).get("/api/tools/route-tool").expect(200);
    expect(detail.body.category).toBe("readonly");

    await request(app).get("/api/tools/missing").expect(404);
  });

  it("filters by category query", async () => {
    const response = await request(app).get("/api/tools?category=network").expect(200);
    expect(response.body.tools.every((tool: { category: string }) => tool.category === "network")).toBe(true);
  });
});
