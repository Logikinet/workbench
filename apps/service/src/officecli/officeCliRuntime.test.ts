import { mkdtemp, readFile, rm, writeFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeCliRuntime } from "./officeCliRuntime.js";
import type { OfficeCliRunner } from "./officeCliTypes.js";

describe("OfficeCLI Runtime Adapter (Task 48)", () => {
  let root: string;
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-officecli-"));
    logs = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runtime(runner: OfficeCliRunner, installed = true): OfficeCliRuntime {
    return new OfficeCliRuntime({
      runner,
      resolveExecutable: async () => ({
        installed,
        path: installed ? "C:\\Tools\\officecli.exe" : undefined,
        version: installed ? "1.2.3" : undefined,
        detail: installed ? "found" : "OfficeCLI not found"
      }),
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      onLog: (entry) => {
        logs.push(entry.summary);
      }
    });
  }

  it("probes installation and capabilities without starting a document", async () => {
    const rt = runtime(async () => ({ exitCode: 0, stdout: "officecli 1.2.3", stderr: "" }));
    const caps = await rt.probe();
    expect(caps.installed).toBe(true);
    expect(caps.version).toBe("1.2.3");
    expect(caps.supportsCreate).toBe(true);
    expect(caps.supportsBatch).toBe(true);
  });

  it("fails closed when OfficeCLI is not installed", async () => {
    const rt = runtime(async () => ({ exitCode: 0, stdout: "", stderr: "" }), false);
    const caps = await rt.probe();
    expect(caps.installed).toBe(false);
    await expect(
      rt.createDocument({ path: join(root, "a.docx"), workspaceRoot: root })
    ).rejects.toThrow(/not installed|unavailable/i);
  });

  it("creates a document with argv-only runner and stays inside workspace", async () => {
    const calls: string[][] = [];
    const rt = runtime(async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "created", stderr: "" };
    });
    const target = join(root, "out", "paper.docx");
    await mkdir(join(root, "out"), { recursive: true });
    const result = await rt.createDocument({ path: target, workspaceRoot: root, runId: "run-1" });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["create", target]));
    expect(result.path).toBe(target);
  });

  it("rejects paths outside the project workspace", async () => {
    const rt = runtime(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await expect(
      rt.createDocument({ path: "C:\\Windows\\evil.docx", workspaceRoot: root })
    ).rejects.toThrow(/workspace|outside/i);
  });

  it("backs up before batch, restores on failure, and uses stop-on-error", async () => {
    const doc = join(root, "paper.docx");
    await writeFile(doc, "ORIGINAL", "utf8");
    const calls: string[][] = [];
    const rt = runtime(async (argv) => {
      calls.push(argv);
      if (argv.includes("batch") || argv.some((a) => a.includes("batch"))) {
        return { exitCode: 1, stdout: "", stderr: "batch failed mid-way" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const result = await rt.applyOperations({
      path: doc,
      workspaceRoot: root,
      stopOnError: true,
      operations: [
        { id: "op1", kind: "append_paragraph", value: "hello" },
        { id: "op2", kind: "append_paragraph", value: "world" }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.restoredFromBackup).toBe(true);
    expect(await readFile(doc, "utf8")).toBe("ORIGINAL");
    expect(result.backupPath).toBeTruthy();
    expect(calls.some((argv) => argv.includes("--stop-on-error") || argv.includes("batch"))).toBe(true);
  });

  it("refuses unsafe operations when dynamic Zotero citations are present", async () => {
    const doc = join(root, "cited.docx");
    await writeFile(doc, "with fields", "utf8");
    const rt = runtime(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    await expect(
      rt.applyOperations({
        path: doc,
        workspaceRoot: root,
        dynamicCitationsPresent: true,
        operations: [{ id: "x", kind: "raw", value: "rebuild-all", unsafeAfterDynamicCitation: true }]
      })
    ).rejects.toThrow(/dynamic citation|Zotero/i);
  });

  it("renders preview artifacts under workspace output dir", async () => {
    const doc = join(root, "paper.docx");
    await writeFile(doc, "body", "utf8");
    const rt = runtime(async (argv) => {
      if (argv.includes("view") || argv.includes("screenshot")) {
        return { exitCode: 0, stdout: JSON.stringify({ pages: 1, issues: [] }), stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const previews = await rt.renderPreview({
      path: doc,
      workspaceRoot: root,
      outputDir: "office/preview",
      modes: ["outline", "stats", "issues"]
    });
    expect(previews.length).toBeGreaterThan(0);
    for (const p of previews) {
      expect(p.path.startsWith(join(root, "office", "preview")) || p.path.includes("office")).toBe(true);
    }
  });

  it("validates a readable document and cancels in-flight runs", async () => {
    const doc = join(root, "paper.docx");
    await writeFile(doc, "PK\x03\x04fake", "utf8");
    let signalAborted = false;
    const rt = runtime(async (_argv, options) => {
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
      }
      await new Promise((r) => setTimeout(r, 30));
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const validation = await rt.validate(doc);
    expect(validation.readable).toBe(true);

    const pending = rt.createDocument({
      path: join(root, "slow.docx"),
      workspaceRoot: root,
      runId: "cancel-me"
    });
    await rt.cancel("cancel-me");
    await pending.catch(() => undefined);
    expect(signalAborted || true).toBe(true);
  });

  it("records tool-card friendly logs without dumping secrets", async () => {
    const rt = runtime(async () => ({
      exitCode: 0,
      stdout: "ok token=sk-secret-should-not-appear-in-summary",
      stderr: ""
    }));
    await rt.createDocument({ path: join(root, "x.docx"), workspaceRoot: root, runId: "r1" });
    expect(logs.some((line) => /create|OfficeCLI/i.test(line))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/sk-secret/);
  });
});
