import { describe, expect, it } from "vitest";
import type { ExportedArtifact } from "./documentTypes.js";
import {
  detectExternalChanges,
  hashBuffer,
  watchFromExport,
  type FileStatPort
} from "./externalEdit.js";
import { contentHash } from "./exportFormats.js";

describe("externalEdit detection", () => {
  const now = () => new Date("2026-04-05T08:00:00.000Z");

  function fakePort(files: Map<string, { bytes: Buffer; mtimeMs: number }>): FileStatPort {
    return {
      async stat(path) {
        const f = files.get(path);
        if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: f.mtimeMs, size: f.bytes.length };
      },
      async readFile(path) {
        const f = files.get(path);
        if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return f.bytes;
      }
    };
  }

  it("registers watch from export artifact", () => {
    const artifact: ExportedArtifact = {
      path: "out/paper.docx",
      format: "docx",
      contentHash: "abc123",
      exportedAt: now().toISOString(),
      sizeBytes: 100,
      kind: "document-docx"
    };
    const w = watchFromExport(artifact, { mtimeMs: 1 });
    expect(w.path).toBe("out/paper.docx");
    expect(w.lastKnownHash).toBe("abc123");
    expect(w.changed).toBe(false);
    expect(w.rereviewTriggered).toBe(false);
  });

  it("detects content change after Office/WPS save", async () => {
    const original = Buffer.from("original docx bytes");
    const edited = Buffer.from("edited by WPS after save");
    const path = "C:/docs/paper.docx";
    const files = new Map([[path, { bytes: original, mtimeMs: 1000 }]]);

    const artifact: ExportedArtifact = {
      path,
      format: "docx",
      contentHash: contentHash(original),
      exportedAt: now().toISOString(),
      sizeBytes: original.length,
      kind: "document-docx"
    };
    const watch = watchFromExport(artifact, { mtimeMs: 1000 });

    const unchanged = await detectExternalChanges([watch], {
      port: fakePort(files),
      now
    });
    expect(unchanged.anyChanged).toBe(false);
    expect(unchanged.rereviewRequired).toBe(false);

    files.set(path, { bytes: edited, mtimeMs: 2000 });
    const changed = await detectExternalChanges([watch], {
      port: fakePort(files),
      now
    });
    expect(changed.anyChanged).toBe(true);
    expect(changed.rereviewRequired).toBe(true);
    expect(changed.watches[0]!.rereviewTriggered).toBe(true);
    expect(changed.watches[0]!.detectedAt).toBe("2026-04-05T08:00:00.000Z");
  });

  it("treats missing file as change requiring re-review", async () => {
    const artifact: ExportedArtifact = {
      path: "missing.md",
      format: "markdown",
      contentHash: hashBuffer(Buffer.from("x")),
      exportedAt: now().toISOString(),
      sizeBytes: 1,
      kind: "document-markdown"
    };
    const result = await detectExternalChanges([watchFromExport(artifact)], {
      port: fakePort(new Map()),
      now
    });
    expect(result.rereviewRequired).toBe(true);
  });
});
