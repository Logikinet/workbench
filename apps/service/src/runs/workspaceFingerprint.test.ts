import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actionKindFromStep,
  captureWorkspaceFingerprint,
  fingerprintsMatch,
  isDangerousActionKind
} from "./workspaceFingerprint.js";

async function git(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`))));
  });
}

describe("workspace fingerprint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paw-fingerprint-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects external content changes for tracked artifact paths", async () => {
    await writeFile(join(root, "notes.md"), "v1", "utf8");
    const first = await captureWorkspaceFingerprint(root, ["notes.md"]);
    await writeFile(join(root, "notes.md"), "v2-external", "utf8");
    const second = await captureWorkspaceFingerprint(root, ["notes.md"]);
    expect(fingerprintsMatch(first, second)).toBe(false);
  });

  it("uses git status when the workspace is a git repository", async () => {
    await git(["init"], root);
    await git(["config", "user.email", "fingerprint@example.test"], root);
    await git(["config", "user.name", "Fingerprint"], root);
    await writeFile(join(root, "tracked.md"), "base", "utf8");
    await git(["add", "tracked.md"], root);
    await git(["commit", "-m", "base"], root);

    const clean = await captureWorkspaceFingerprint(root, ["tracked.md"]);
    expect(clean.kind).toBe("git_status");

    await writeFile(join(root, "tracked.md"), "dirty", "utf8");
    const dirty = await captureWorkspaceFingerprint(root, ["tracked.md"]);
    expect(fingerprintsMatch(clean, dirty)).toBe(false);
  });

  it("classifies dangerous action kinds that must not auto-replay", () => {
    expect(isDangerousActionKind("delete_file")).toBe(true);
    expect(isDangerousActionKind("overwrite_file")).toBe(true);
    expect(isDangerousActionKind("system_install")).toBe(true);
    expect(isDangerousActionKind("external_send")).toBe(true);
    expect(isDangerousActionKind("write_file")).toBe(false);
    expect(actionKindFromStep("delete_file:legacy.md")).toBe("delete_file");
    expect(actionKindFromStep("overwrite_file:notes.md")).toBe("overwrite_file");
    expect(actionKindFromStep("write_file:notes.md")).toBe("write_file");
  });

  it("detects nested directory content changes without tracked artifact paths", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.md"), "a", "utf8");
    const first = await captureWorkspaceFingerprint(root, []);
    await writeFile(join(root, "docs", "a.md"), "b", "utf8");
    const second = await captureWorkspaceFingerprint(root, []);
    expect(first.kind === "content_hash" || first.kind === "git_status").toBe(true);
    expect(fingerprintsMatch(first, second)).toBe(false);
  });
});
