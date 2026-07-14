/**
 * Detect Office/WPS external edits after export (Task 33).
 * On change → mark needs re-review (no full online Office editor).
 */

import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import type { ExportedArtifact, ExternalEditWatch } from "./documentTypes.js";
import { contentHash } from "./exportFormats.js";

export interface FileStatPort {
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(path: string): Promise<Buffer>;
}

export const defaultFileStatPort: FileStatPort = {
  async stat(path) {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  async readFile(path) {
    return readFile(path);
  }
};

/** Register a watch from an export artifact (hash at export time). */
export function watchFromExport(
  artifact: ExportedArtifact,
  options: { mtimeMs?: number; size?: number } = {}
): ExternalEditWatch {
  return {
    path: artifact.path,
    lastKnownHash: artifact.contentHash,
    lastKnownMtimeMs: options.mtimeMs,
    lastKnownSize: options.size ?? artifact.sizeBytes,
    changed: false,
    rereviewTriggered: false
  };
}

export interface DetectResult {
  watches: ExternalEditWatch[];
  anyChanged: boolean;
  rereviewRequired: boolean;
}

/**
 * Compare on-disk files to last known hash/mtime.
 * Hash mismatch (or size/mtime when hash unavailable) triggers re-review.
 */
export async function detectExternalChanges(
  watches: ExternalEditWatch[],
  options: {
    port?: FileStatPort;
    now?: () => Date;
    /** Prefer full content hash when true (default). */
    hashContents?: boolean;
  } = {}
): Promise<DetectResult> {
  const port = options.port ?? defaultFileStatPort;
  const now = options.now ?? (() => new Date());
  const hashContents = options.hashContents !== false;
  const updated: ExternalEditWatch[] = [];
  let anyChanged = false;

  for (const w of watches) {
    try {
      const st = await port.stat(w.path);
      let changed = false;
      let newHash = w.lastKnownHash;

      if (hashContents) {
        const bytes = await port.readFile(w.path);
        newHash = contentHash(bytes);
        changed = newHash !== w.lastKnownHash;
      } else {
        changed =
          (w.lastKnownMtimeMs !== undefined && st.mtimeMs !== w.lastKnownMtimeMs)
          || (w.lastKnownSize !== undefined && st.size !== w.lastKnownSize);
        if (changed) {
          const bytes = await port.readFile(w.path);
          newHash = contentHash(bytes);
          // confirm real content change
          changed = newHash !== w.lastKnownHash;
        }
      }

      if (changed) {
        anyChanged = true;
        updated.push({
          ...w,
          changed: true,
          detectedAt: now().toISOString(),
          rereviewTriggered: true,
          lastKnownMtimeMs: st.mtimeMs,
          lastKnownSize: st.size
          // keep lastKnownHash as export hash so we know the baseline
        });
      } else {
        updated.push({
          ...w,
          changed: false,
          lastKnownMtimeMs: st.mtimeMs,
          lastKnownSize: st.size,
          lastKnownHash: newHash
        });
      }
    } catch {
      // Missing file is treated as change requiring attention
      anyChanged = true;
      updated.push({
        ...w,
        changed: true,
        detectedAt: now().toISOString(),
        rereviewTriggered: true
      });
    }
  }

  return {
    watches: updated,
    anyChanged,
    rereviewRequired: anyChanged
  };
}

/** Hash helper for tests without filesystem. */
export function hashBuffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}
