/**
 * Project-aware verification types (Ticket 25).
 *
 * Commands must come from project evidence, user specification, or an explicit
 * hypothesis — never a blind default of npm test/typecheck/build.
 */

export type ProjectStackKind =
  | "nodejs"
  | "python"
  | "html"
  | "git"
  | "harmonyos"
  | "cangjie"
  | "mixed"
  | "unknown";

export type VerificationCommandSource = "project_evidence" | "user_specified" | "hypothesis";

export type VerificationTaskType =
  | "implementation"
  | "bug_fix"
  | "research"
  | "writing"
  | "analysis"
  | "automation"
  | "other";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ProjectStackClue {
  kind: ProjectStackKind;
  /** Workspace-relative path of the clue file/dir. */
  path: string;
  detail: string;
  confidence: "high" | "medium" | "low";
}

export interface AvailableScript {
  name: string;
  /** Raw script body when known (e.g. package.json scripts.test). */
  command?: string;
  /** Evidence path, e.g. package.json or pyproject.toml. */
  source: string;
}

export interface DetectedProjectStack {
  primary: ProjectStackKind;
  kinds: ProjectStackKind[];
  clues: ProjectStackClue[];
  availableScripts: AvailableScript[];
  packageManager?: PackageManager;
  hasAutomatedTests: boolean;
  workspacePath: string;
}

export interface VerificationCommandEntry {
  /** argv form, never shell-interpolated. */
  command: string[];
  enabled: boolean;
  source: VerificationCommandSource;
  rationale: string;
  /** Evidence path supporting this command, when any. */
  evidencePath?: string;
}

export interface ManualChecklistItem {
  id: string;
  description: string;
  source: VerificationCommandSource;
  rationale: string;
  /** User may mark complete during review; optional at plan time. */
  completed?: boolean;
}

export type VerificationPlanStatus = "draft" | "approved" | "superseded";

/**
 * Editable verification scheme produced before plan approval and bound to an
 * approved plan version after the user approves.
 */
export interface VerificationPlan {
  stack: DetectedProjectStack;
  commands: VerificationCommandEntry[];
  manualChecklist: ManualChecklistItem[];
  assumptions: string[];
  status: VerificationPlanStatus;
  /** Set when bound to an approved Secondmate plan version. */
  approvedPlanVersion?: number;
  taskType?: VerificationTaskType;
}

export interface VerificationResultRow {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Structured row for Reviewer / PWA — use `passed`, not log keywords. */
export interface VerificationEvidenceRow extends VerificationResultRow {
  passed: boolean;
  source?: VerificationCommandSource;
}

export interface ManualChecklistEvidence {
  id: string;
  description: string;
  completed: boolean;
  note?: string;
}

/**
 * Normalized verification evidence for Reviewer and Artifact indexes.
 * Compatible shape with runService ArtifactVerificationEvidence rows.
 */
export interface VerificationEvidence {
  kind: "project-verification";
  planVersion?: number;
  stackPrimary: ProjectStackKind;
  results: VerificationEvidenceRow[];
  manualChecklist: ManualChecklistEvidence[];
  summary: string;
  allPassed: boolean;
  recordedAt: string;
}

export interface ProposeVerificationInput {
  stack: DetectedProjectStack;
  taskType?: VerificationTaskType;
  /** User-specified argv commands (highest priority). */
  userCommands?: string[][];
  /** Commands the user disabled (matched by argv equality). */
  disabledCommands?: string[][];
  /** Extra user supplements beyond detected ones. */
  supplementalCommands?: string[][];
  /** Free-text constraints from the user (e.g. "only run unit tests"). */
  userConstraints?: string;
}

export interface ApplyUserEditsInput {
  plan: VerificationPlan;
  /** Full replacement list when provided (enabled entries become the plan commands). */
  commands?: Array<{
    command: string[];
    enabled?: boolean;
    source?: VerificationCommandSource;
    rationale?: string;
  }>;
  manualChecklist?: Array<{
    id?: string;
    description: string;
    completed?: boolean;
  }>;
}
