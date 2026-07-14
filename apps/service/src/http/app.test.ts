import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("local Agent Service health contract", () => {
  it("reports version and available capabilities to the installed PWA", async () => {
    const response = await request(createApp({ version: "0.1.0" }))
      .get("/api/health")
      .expect(200);

    expect(response.body).toEqual({
      status: "online",
      version: "0.1.0",
      capabilities: expect.arrayContaining(["projects", "todos"])
    });
  });

  it("accepts only loopback clients", async () => {
    const app = createApp({
      version: "0.1.0",
      clientAddress: () => "192.168.1.30"
    });

    await request(app).get("/api/health").expect(403, {
      error: "This service accepts local connections only."
    });
  });

  it("allows the installed local PWA to read its health check without opening CORS to remote sites", async () => {
    const app = createApp({ version: "0.1.0" });

    await request(app)
      .get("/api/health")
      .set("Origin", "http://127.0.0.1:5173")
      .expect("access-control-allow-origin", "http://127.0.0.1:5173")
      .expect(200);

    await request(app)
      .get("/api/health")
      .set("Origin", "https://example.test")
      .expect(403, { error: "This service accepts local origins only." });
  });

  it("advertises PUT in CORS Allow-Methods so the PWA can save queue config across origins", async () => {
    const app = createApp({ version: "0.1.0" });
    const preflight = await request(app)
      .options("/api/queue/config")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toMatch(/\bPUT\b/);
    expect(preflight.headers["access-control-allow-methods"]).toMatch(/\bPOST\b/);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });

  it("serves the installed PWA from webRoot on the same loopback origin as the API", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "paw-web-"));
    await writeFile(
      join(webRoot, "index.html"),
      "<!doctype html><title>PAW</title><h1>Personal AI Workbench</h1>",
      "utf8"
    );
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "assets", "app.js"), "console.log('paw')", "utf8");

    const app = createApp({ version: "0.1.0", webRoot });

    const index = await request(app).get("/").expect(200);
    expect(index.text).toContain("Personal AI Workbench");

    const asset = await request(app).get("/assets/app.js").expect(200);
    expect(asset.text).toContain("paw");

    // SPA fallback for client routes / hash-deep-links still returns the shell.
    const spa = await request(app).get("/some-client-route").expect(200);
    expect(spa.text).toContain("Personal AI Workbench");

    // API routes remain authoritative and are not swallowed by static hosting.
    await request(app).get("/api/health").expect(200);
  });
});
