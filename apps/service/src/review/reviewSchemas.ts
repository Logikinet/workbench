import type { JsonSchema } from "../model/jsonSchema.js";

/**
 * Independent LLM Reviewer system instruction.
 * Reviewer never inherits the executor chat, never calls write tools, and only emits a report.
 */
export const REVIEWER_SYSTEM_INSTRUCTION = [
  "You are the Independent Reviewer for Personal AI Workbench.",
  "You review completed Professional Agent work against the original goal and approved plan.",
  "You receive an independent review context only — not the executor's full multi-turn conversation.",
  "You MUST NOT call tools, write files, run shell commands, modify artifacts, or apply patches.",
  "You only produce a structured review report as JSON.",
  "Evaluate each acceptance criterion with supporting evidence from the provided context.",
  "Detect: requirement omissions, out-of-scope / boundary violations, conclusions without evidence,",
  "failed or fake verification (keyword-only 'passed' without exitCode/structured results), and incomplete artifacts.",
  "Prefer concrete evidence quotes from the context over agent self-claims.",
  "If evidence is insufficient for a criterion, mark it unmet with severity high or critical.",
  "List residual risks even when the overall conclusion is passed.",
  "Never claim the work is done for the user — final acceptance is a separate human step."
].join("\n");

const severityEnum = ["none", "low", "medium", "high", "critical"] as const;

/** Structured Independent Reviewer model output (task 28). */
export const reviewerOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "conclusion",
    "summary",
    "evidence",
    "severity",
    "findings",
    "residualRisks",
    "modifiedArtifacts"
  ],
  properties: {
    conclusion: { type: "string", enum: ["passed", "changes_requested"] },
    summary: { type: "string", minLength: 1 },
    evidence: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    severity: { type: "string", enum: [...severityEnum] },
    fixScope: { type: "string" },
    residualRisks: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    findings: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met", "evidence", "severity"],
        properties: {
          criterion: { type: "string", minLength: 1 },
          met: { type: "boolean" },
          evidence: { type: "string", minLength: 1 },
          severity: { type: "string", enum: [...severityEnum] },
          fixScope: { type: "string" }
        }
      }
    },
    /** Reviewer never mutates artifacts; must always be false. */
    modifiedArtifacts: { type: "boolean", const: false }
  }
};

export interface ReviewerModelFinding {
  criterion: string;
  met: boolean;
  evidence: string;
  severity: (typeof severityEnum)[number];
  fixScope?: string;
}

export interface ReviewerModelOutput {
  conclusion: "passed" | "changes_requested";
  summary: string;
  evidence: string[];
  severity: (typeof severityEnum)[number];
  fixScope?: string;
  residualRisks: string[];
  findings: ReviewerModelFinding[];
  modifiedArtifacts: false;
}
