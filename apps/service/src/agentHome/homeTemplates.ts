/**
 * Versioned Agent Home templates (Task 37).
 *
 * Inspired by NextClaw workspace files (AGENTS/IDENTITY/USER/TOOLS/MEMORY)
 * but adapted for PAW: project isolation, Firstmate hard rules, layered memory.
 */

import type { HomeProfileFile } from "./agentHomeTypes.js";

/** Bump when default template bodies change; homes migrate on open/ensure. */
export const CURRENT_TEMPLATE_VERSION = 1;

export interface TemplateRenderContext {
  displayName?: string;
  roleId?: string;
  kind: "long_term" | "temporary";
}

function nameOr(ctx: TemplateRenderContext, fallback: string): string {
  const n = ctx.displayName?.trim();
  return n || fallback;
}

export function defaultTemplateContent(
  file: HomeProfileFile,
  ctx: TemplateRenderContext
): string {
  const name = nameOr(ctx, "Agent");
  switch (file) {
    case "AGENTS.md":
      return renderAgents(name, ctx);
    case "IDENTITY.md":
      return renderIdentity(name, ctx);
    case "USER.md":
      return renderUser();
    case "TOOLS.md":
      return renderTools();
    case "MEMORY.md":
      return renderMemory(name, ctx);
    default: {
      const _exhaustive: never = file;
      return _exhaustive;
    }
  }
}

export function allDefaultTemplates(ctx: TemplateRenderContext): Record<HomeProfileFile, string> {
  return {
    "AGENTS.md": defaultTemplateContent("AGENTS.md", ctx),
    "IDENTITY.md": defaultTemplateContent("IDENTITY.md", ctx),
    "USER.md": defaultTemplateContent("USER.md", ctx),
    "TOOLS.md": defaultTemplateContent("TOOLS.md", ctx),
    "MEMORY.md": defaultTemplateContent("MEMORY.md", ctx)
  };
}

/**
 * Apply sequential template migrations when templateVersion < CURRENT.
 * Returns new file contents for files that should be updated when still default-like,
 * and the version reached. User-edited files are left alone unless force.
 */
export function migrateTemplates(input: {
  fromVersion: number;
  currentFiles: Partial<Record<HomeProfileFile, string>>;
  ctx: TemplateRenderContext;
  forceReplace?: boolean;
}): {
  toVersion: number;
  files: Partial<Record<HomeProfileFile, string>>;
  migrated: HomeProfileFile[];
} {
  let version = input.fromVersion;
  const files: Partial<Record<HomeProfileFile, string>> = { ...input.currentFiles };
  const migrated: HomeProfileFile[] = [];

  // v0 → v1: seed missing profile files with v1 defaults
  if (version < 1) {
    const defaults = allDefaultTemplates(input.ctx);
    for (const file of Object.keys(defaults) as HomeProfileFile[]) {
      const existing = files[file];
      if (input.forceReplace || existing === undefined || existing.trim() === "") {
        files[file] = defaults[file];
        migrated.push(file);
      }
    }
    version = 1;
  }

  // Future: if (version < 2) { ... version = 2 }

  return {
    toVersion: Math.max(version, CURRENT_TEMPLATE_VERSION),
    files,
    migrated
  };
}

function renderAgents(name: string, ctx: TemplateRenderContext): string {
  return [
    `# AGENTS.md — ${name} workspace guide`,
    "",
    "This Home is role-private. Do not share writable memory with other Agent Roles.",
    "",
    "## Every session",
    "",
    "1. Read `IDENTITY.md` (who you are for this role).",
    "2. Read `USER.md` (preferences that apply to this role).",
    "3. Read `TOOLS.md` for local tool notes.",
    "4. Load layered memory only as needed (global prefs / project facts / task checkpoints / role experience).",
    "5. Load private `MEMORY.md` only in the owning role's private session — never for shared evidence or other agents.",
    "",
    "## Continuity",
    "",
    "- Files are continuity; do not dump entire chats into long-term memory.",
    "- Record a **source** for every memory write.",
    "- Uncertain inferences must be stored as inferences, never as facts.",
    "",
    "## Hard boundaries (system)",
    "",
    "- Firstmate hard security and orchestration rules are system-fixed.",
    "- This Home may **supplement** role behaviour only; it cannot override those hard rules.",
    "- Stay inside the approved Project workspace and Role permissions.",
    "",
    `## Home kind`,
    "",
    `- Kind: \`${ctx.kind}\``,
    ctx.roleId ? `- Role id: \`${ctx.roleId}\`` : "- Role id: _(unbound temporary home)_",
    ""
  ].join("\n");
}

function renderIdentity(name: string, ctx: TemplateRenderContext): string {
  return [
    `# IDENTITY.md — Who am I?`,
    "",
    `- Name: ${name}`,
    `- Role id: ${ctx.roleId ?? "(temporary)"}`,
    `- Kind: ${ctx.kind}`,
    "- Vibe: (edit me)",
    "- Responsibility notes:",
    "",
    "Describe how this role should behave. Do not attempt to override Firstmate hard rules.",
    ""
  ].join("\n");
}

function renderUser(): string {
  return [
    `# USER.md — About the human (role-visible prefs)`,
    "",
    "- Name:",
    "- What to call them:",
    "- Timezone:",
    "- Notes:",
    "",
    "## Preferences",
    "",
    "Capture stable preferences that help this role. Keep secrets out of this file.",
    ""
  ].join("\n");
}

function renderTools(): string {
  return [
    `# TOOLS.md — Local tool notes`,
    "",
    "Skills define methods. This file holds environment-specific notes for this role only.",
    "",
    "## What goes here",
    "",
    "- Preferred commands or entry points",
    "- Device or path aliases that are safe to remember",
    "- Setup details that should not be re-discovered every session",
    "",
    "Do not store credentials or API keys here.",
    ""
  ].join("\n");
}

function renderMemory(name: string, ctx: TemplateRenderContext): string {
  return [
    `# MEMORY.md — Private long-term memory (${name})`,
    "",
    "This file is **private to this Agent Role**. It must not be copied into:",
    "- other Agent Homes",
    "- shared evidence packs",
    "- ordinary Project artifacts",
    "",
    "## How to write",
    "",
    "- Always record a source (user statement, tool result path, approved plan id, etc.).",
    "- Tag uncertain content as inference; never promote inference to fact without confirmation.",
    "- Prefer structured layered memory APIs for global prefs / project facts / task checkpoints / role experience.",
    "",
    "## Role experience (summary)",
    "",
    ctx.kind === "temporary"
      ? "_(Temporary home — promote to a long-term role to retain this memory.)_"
      : "(Key durable lessons for this role go here.)",
    ""
  ].join("\n");
}
