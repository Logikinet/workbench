import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PathSafetyError,
  isInsideRoot,
  resolveExistingSafePath,
  resolveSafePath,
  toProjectRelative
} from "./pathSafety.js";

describe("pathSafety (Task 42)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-path-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.md"), "# hi", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves relative paths and rejects traversal / absolute", () => {
    expect(resolveSafePath(root, "docs/a.md").relativePath).toBe("docs/a.md");
    expect(resolveSafePath(root, "").relativePath).toBe("");
    expect(toProjectRelative("docs\\a.md")).toBe("docs/a.md");

    expect(() => resolveSafePath(root, "../outside")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "..\\secret")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "docs/../../etc/passwd")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "C:\\Windows\\System32")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(PathSafetyError);
    expect(() => resolveSafePath(root, "foo\0bar")).toThrow(PathSafetyError);
  });

  it("resolveExistingSafePath finds files and rejects missing", async () => {
    const found = await resolveExistingSafePath(root, "docs/a.md");
    expect(found.relativePath).toBe("docs/a.md");
    expect(found.realPath).toContain("a.md");

    await expect(resolveExistingSafePath(root, "missing.txt")).rejects.toMatchObject({
      code: "not_found"
    });
  });

  it("isInsideRoot rejects parents", () => {
    expect(isInsideRoot(root, join(root, "docs"))).toBe(true);
    expect(isInsideRoot(root, join(root, ".."))).toBe(false);
  });

  it("blocks symlink escape when supported", async () => {
    const outside = await mkdtemp(join(tmpdir(), "paw-out-"));
    await writeFile(join(outside, "secret.txt"), "nope", "utf8");
    const link = join(root, "escape-link");
    try {
      await symlink(outside, link, "junction");
      await expect(resolveExistingSafePath(root, "escape-link/secret.txt")).rejects.toThrow(
        /outside|escapes|not found|relative/i
      );
    } catch (error) {
      // Some environments disallow symlinks; treat as skip.
      if (error instanceof Error && /symlink|privilege|EPERM/i.test(error.message)) {
        return;
      }
      // If the expectation itself threw PathSafetyError — good.
      if (error instanceof PathSafetyError) return;
      throw error;
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
