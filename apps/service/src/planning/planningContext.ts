/**
 * Planning context selection: load only necessary facts and record usage.
 * Never reads secrets or mutates the workspace.
 */

export interface RelatedPlanningFile {
  path: string;
  excerpt?: string;
  reason?: string;
}

export interface PlanningProjectFacts {
  id?: string;
  name: string;
  summary?: string;
  workspacePath?: string;
}

export interface PlanningContextInput {
  todo: { title: string; description?: string };
  /** User messages / instructions for this Run. */
  instructions?: string;
  project?: PlanningProjectFacts;
  workspaceSummary?: string;
  relatedFiles?: RelatedPlanningFile[];
  revisionNote?: string;
  /** Soft cap on related files included in the model prompt. */
  maxRelatedFiles?: number;
  /** Soft cap on excerpt characters per file. */
  maxExcerptChars?: number;
}

export interface PlanningContextUsage {
  projectFacts: string[];
  files: string[];
  assumptions: string[];
  workspaceSummary?: string;
  instructionSources: string[];
  omittedBecauseUnnecessary: string[];
}

export interface SelectedPlanningContext {
  /** Compact payload safe to send to the model (no secrets). */
  promptText: string;
  usage: PlanningContextUsage;
  /** Whether the subject still lacks any outcome description. */
  missingOutcomeDescription: boolean;
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_EXCERPT = 800;

/**
 * Select necessary planning context only. Does not touch the filesystem.
 * Callers supply already-authorized, non-secret excerpts.
 */
export function selectPlanningContext(input: PlanningContextInput): SelectedPlanningContext {
  const maxFiles = input.maxRelatedFiles ?? DEFAULT_MAX_FILES;
  const maxExcerpt = input.maxExcerptChars ?? DEFAULT_MAX_EXCERPT;
  const title = input.todo.title.trim();
  const description = input.todo.description?.trim() || "";
  const instructions = input.instructions?.trim() || "";
  const revisionNote = input.revisionNote?.trim() || "";
  const workspaceSummary = input.workspaceSummary?.trim() || "";

  const projectFacts: string[] = [];
  if (input.project?.name?.trim()) projectFacts.push(`project.name=${input.project.name.trim()}`);
  if (input.project?.summary?.trim()) projectFacts.push(`project.summary=${input.project.summary.trim()}`);
  if (input.project?.workspacePath?.trim()) projectFacts.push(`project.workspacePath=${input.project.workspacePath.trim()}`);
  if (input.project?.id?.trim()) projectFacts.push(`project.id=${input.project.id.trim()}`);

  const keywordSource = [title, description, instructions, revisionNote].join("\n").toLocaleLowerCase();
  const ranked = rankRelatedFiles(input.relatedFiles ?? [], keywordSource);
  const selected = ranked.slice(0, maxFiles);
  const omitted = ranked.slice(maxFiles).map((file) => file.path);

  const fileLines = selected.map((file) => {
    const excerpt = truncate(file.excerpt?.trim() || "", maxExcerpt);
    const reason = file.reason?.trim() || "related";
    return excerpt
      ? `- ${file.path} (${reason}):\n${excerpt}`
      : `- ${file.path} (${reason})`;
  });

  const instructionSources: string[] = [];
  if (title) instructionSources.push("todo.title");
  if (description) instructionSources.push("todo.description");
  if (instructions) instructionSources.push("run.instructions");
  if (revisionNote) instructionSources.push("revisionNote");

  const usage: PlanningContextUsage = {
    projectFacts: [...projectFacts],
    files: selected.map((file) => file.path),
    assumptions: [],
    workspaceSummary: workspaceSummary || undefined,
    instructionSources,
    omittedBecauseUnnecessary: omitted
  };

  const sections = [
    "## Todo",
    `Title: ${title || "(empty)"}`,
    description ? `Description: ${description}` : "Description: (none)",
    instructions ? `Instructions:\n${instructions}` : "Instructions: (none)",
    revisionNote ? `Revision feedback:\n${revisionNote}` : null,
    "## Project facts",
    projectFacts.length > 0 ? projectFacts.join("\n") : "(none provided)",
    "## Workspace summary",
    workspaceSummary || "(none provided)",
    "## Related files (excerpts only; do not mutate)",
    fileLines.length > 0 ? fileLines.join("\n") : "(none provided)",
    "## Hard rules",
    "- Planning must not modify formal files or run dangerous commands.",
    "- Firstmate never produces formal Artifacts.",
    "- Prefer minimal necessary scope for the stated outcome."
  ].filter((line): line is string => line !== null);

  const missingOutcomeDescription = !description && !instructions;

  return {
    promptText: sections.join("\n"),
    usage,
    missingOutcomeDescription
  };
}

function rankRelatedFiles(files: RelatedPlanningFile[], keywordSource: string): RelatedPlanningFile[] {
  const tokens = keywordSource
    .split(/[^a-zA-Z0-9_\u4e00-\u9fff./-]+/)
    .map((token) => token.trim().toLocaleLowerCase())
    .filter((token) => token.length >= 3);

  return [...files]
    .map((file, index) => {
      const haystack = `${file.path} ${file.reason ?? ""} ${file.excerpt ?? ""}`.toLocaleLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
      }
      if (file.excerpt?.trim()) score += 0.25;
      if (file.reason?.trim()) score += 0.1;
      return { file, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.file);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
