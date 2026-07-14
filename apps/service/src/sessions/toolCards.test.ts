import { describe, expect, it } from "vitest";
import {
  applyToolResult,
  applyToolUpdate,
  compactCard,
  createToolCardPayload,
  formatDuration,
  inferToolPermission,
  maybeTruncateLogBody,
  summarizeArguments,
  summarizeOutput,
  toolCardSummary
} from "./toolCards.js";
import type { SessionCard } from "./sessionTypes.js";
import { LONG_LOG_COLLAPSE_CHARS, MAX_LOG_BODY_CHARS } from "./sessionTypes.js";

describe("toolCards helpers", () => {
  it("infers permission categories from tool names", () => {
    expect(inferToolPermission("read_file")).toBe("readonly");
    expect(inferToolPermission("filesystem_write")).toBe("write");
    expect(inferToolPermission("shell")).toBe("shell");
    expect(inferToolPermission("web_fetch")).toBe("network");
    expect(inferToolPermission("dangerous_exec")).toBe("dangerous");
    expect(inferToolPermission("custom-thing")).toBe("unknown");
  });

  it("creates a tool card with redacted argument summary", () => {
    const card = createToolCardPayload({
      toolCallId: "tc-1",
      toolName: "web_fetch",
      arguments: { url: "https://example.com", api_key: "sk-secret-value-123456" },
      startedAt: "2026-07-15T10:00:00.000Z"
    });
    expect(card.permission).toBe("network");
    expect(card.status).toBe("pending");
    expect(card.argumentsSummary).toContain("url");
    expect(card.argumentsSummary).not.toMatch(/sk-secret/);
    expect(card.arguments?.api_key).toBe("[REDACTED]");
    expect(card.title).toBe("web_fetch");
  });

  it("applies tool result with duration, artifacts, and evidence", () => {
    const base = createToolCardPayload({
      toolCallId: "tc-2",
      toolName: "read_file",
      arguments: { path: "src/main.ts" },
      startedAt: "2026-07-15T10:00:00.000Z"
    });
    const done = applyToolResult(base, {
      ok: true,
      resultSummary: "Read 120 lines",
      completedAt: "2026-07-15T10:00:01.500Z",
      artifacts: [{ path: "out/report.md", kind: "document", summary: "Report" }],
      evidence: [{ id: "ev-1", summary: "unit tests passed" }]
    });
    expect(done.status).toBe("completed");
    expect(done.ok).toBe(true);
    expect(done.durationMs).toBe(1500);
    expect(done.outputSummary).toContain("120 lines");
    expect(done.artifactLinks).toHaveLength(1);
    expect(done.evidenceLinks[0]?.id).toBe("ev-1");
    expect(toolCardSummary(done)).toMatch(/read_file/);
    expect(toolCardSummary(done)).toMatch(/1\.5s/);
  });

  it("marks failed tool results and applies status updates", () => {
    const base = createToolCardPayload({
      toolCallId: "tc-3",
      toolName: "shell",
      status: "in_progress"
    });
    const failed = applyToolResult(base, {
      ok: false,
      resultSummary: "exit 1",
      durationMs: 40
    });
    expect(failed.status).toBe("failed");
    expect(failed.ok).toBe(false);

    const pending = applyToolUpdate(base, { status: "awaiting_approval", title: "Run tests" });
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.title).toBe("Run tests");
  });

  it("summarizes empty args and truncates long output", () => {
    expect(summarizeArguments(undefined)).toBe("(no args)");
    expect(summarizeArguments({})).toBe("(no args)");
    const long = "x".repeat(2000);
    expect(summarizeOutput(long).endsWith("…")).toBe(true);
    expect(summarizeOutput(long).length).toBeLessThanOrEqual(481);
  });

  it("collapses and truncates long log bodies", () => {
    const medium = "m".repeat(LONG_LOG_COLLAPSE_CHARS + 10);
    const mid = maybeTruncateLogBody(medium);
    expect(mid.collapsed).toBe(true);
    expect(mid.truncated).toBe(false);

    const huge = "h".repeat(MAX_LOG_BODY_CHARS + 50);
    const big = maybeTruncateLogBody(huge);
    expect(big.truncated).toBe(true);
    expect(big.collapsed).toBe(true);
    expect(big.body.length).toBeLessThan(huge.length);
  });

  it("compacts cards for virtualized pages", () => {
    const card: SessionCard = {
      id: "c1",
      sessionId: "s1",
      turnId: "t1",
      kind: "tool_call",
      sequence: 1,
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
      collapsed: false,
      summary: "tool",
      logBody: "L".repeat(LONG_LOG_COLLAPSE_CHARS + 5),
      tool: createToolCardPayload({
        toolCallId: "tc",
        toolName: "read_file",
        arguments: { path: "a.ts" }
      })
    };
    const compact = compactCard(card);
    expect(compact.collapsed).toBe(true);
    expect(compact.logBody).toBeUndefined();
    expect(compact.tool?.arguments).toBeUndefined();
    expect(compact.tool?.argumentsSummary).toBeTruthy();
  });

  it("formats durations", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(120_000)).toBe("2.0m");
  });
});
