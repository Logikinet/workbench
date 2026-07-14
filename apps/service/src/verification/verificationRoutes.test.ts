import express from "express";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerVerificationRoutes } from "./verificationRoutes.js";
import { createVerificationService } from "./verificationService.js";

describe("verificationRoutes", () => {
  it("detects and proposes via mountable HTTP routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paw-vr-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

    const app = express();
    app.use(express.json());
    registerVerificationRoutes(app, { verification: createVerificationService() });

    const detected = await request(app).post("/api/verification/detect").send({ workspacePath: root }).expect(200);
    expect(detected.body.primary).toBe("nodejs");

    const proposed = await request(app).post("/api/verification/propose").send({
      workspacePath: root,
      taskType: "implementation"
    }).expect(200);
    expect(proposed.body.commands.some((entry: { command: string[] }) => entry.command.join(" ") === "npm test")).toBe(true);
  });

  it("checks execution against approved commands", async () => {
    const app = express();
    app.use(express.json());
    registerVerificationRoutes(app);

    const ok = await request(app).post("/api/verification/check-execution").send({
      requested: [["pytest"]],
      approved: [["pytest"]]
    }).expect(200);
    expect(ok.body.ok).toBe(true);

    const bad = await request(app).post("/api/verification/check-execution").send({
      requested: [["npm", "test"]],
      approved: [["pytest"]]
    }).expect(200);
    expect(bad.body.ok).toBe(false);
  });

  it("structures evidence over HTTP", async () => {
    const app = express();
    app.use(express.json());
    registerVerificationRoutes(app);

    const response = await request(app).post("/api/verification/evidence").send({
      stackPrimary: "python",
      planVersion: 1,
      results: [{ command: ["pytest"], exitCode: 0, stdout: "ok", stderr: "" }]
    }).expect(200);

    expect(response.body.kind).toBe("project-verification");
    expect(response.body.results[0].passed).toBe(true);
  });

  it("patches run verification commands through updatePlanning", async () => {
    const updatePlanning = vi.fn().mockResolvedValue({ id: "run-1", planning: { verificationCommands: [["pytest"]] } });
    const app = express();
    app.use(express.json());
    registerVerificationRoutes(app, {
      runs: {
        get: vi.fn(),
        updatePlanning
      }
    });

    const response = await request(app)
      .patch("/api/runs/run-1/verification")
      .send({ verificationCommands: [["pytest"]] })
      .expect(200);

    expect(updatePlanning).toHaveBeenCalledWith("run-1", expect.objectContaining({
      verificationCommands: [["pytest"]]
    }));
    expect(response.body.planning.verificationCommands).toEqual([["pytest"]]);
  });
});
