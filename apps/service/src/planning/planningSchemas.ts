import type { JsonSchema } from "../model/jsonSchema.js";

/** Keep in sync with planningService.taskTypes (avoid circular imports). */
const TASK_TYPE_ENUM = [
  "implementation",
  "bug_fix",
  "research",
  "writing",
  "analysis",
  "automation",
  "other"
] as const;

/** Structured Firstmate assessment output (task understanding only — no formal mutations). */
export const firstmateAssessmentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskType",
    "requiredCapabilities",
    "criticalInputs",
    "assumptions",
    "complexity",
    "rationale",
    "usedProjectFacts",
    "usedFiles",
    "insufficientEvidence",
    "evidenceGaps"
  ],
  properties: {
    taskType: { type: "string", enum: [...TASK_TYPE_ENUM] },
    requiredCapabilities: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    criticalInputs: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    assumptions: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    complexity: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string", minLength: 1 },
    usedProjectFacts: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    usedFiles: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    insufficientEvidence: { type: "boolean" },
    evidenceGaps: {
      type: "array",
      items: { type: "string", minLength: 1 }
    }
  }
};

/** Structured Secondmate plan output — task-specific, never a fixed template for all tasks. */
export const secondmatePlanSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "complexity",
    "steps",
    "dependencies",
    "expectedArtifacts",
    "allowedScope",
    "prohibitions",
    "verificationMethods",
    "acceptanceCriteria",
    "risks",
    "verificationCommands"
  ],
  properties: {
    summary: { type: "string", minLength: 1 },
    complexity: { type: "string", enum: ["low", "medium", "high"] },
    steps: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1
    },
    dependencies: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    expectedArtifacts: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    allowedScope: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    prohibitions: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1
    },
    verificationMethods: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    acceptanceCriteria: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1
    },
    risks: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    verificationCommands: {
      type: "array",
      items: {
        type: "array",
        items: { type: "string", minLength: 1 }
      }
    }
  }
};

export const FIRSTMATE_SYSTEM_INSTRUCTION = [
  "You are Firstmate: you only understand and orchestrate tasks.",
  "Never create, modify, or delete formal project files.",
  "Never execute dangerous commands or produce formal Artifacts.",
  "Assess the Todo using only the provided project facts, workspace summary, and related inputs.",
  "Identify taskType, requiredCapabilities, critical missing inputs, assumptions, and complexity.",
  "Record which project facts and file paths you actually used.",
  "If evidence is insufficient to plan safely, set insufficientEvidence=true and list evidenceGaps.",
  "Only mark criticalInputs when the user must supply a result or decision before planning can continue.",
  "Respond with JSON that matches the provided schema."
].join("\n");

export const SECOND_MATE_SYSTEM_INSTRUCTION = [
  "You are Secondmate: you produce task-specific execution plans for an approved Project workspace.",
  "Never create, modify, or delete formal project files during planning.",
  "Never run shell commands or produce formal Artifacts before the plan is approved.",
  "Plans must differ by task type: implementation, bug_fix, research, writing, analysis, automation, other.",
  "Simple (low complexity) tasks get lean plans; complex tasks get full step breakdowns.",
  "Include steps, dependencies, expected Artifacts, allowedScope, prohibitions, verificationMethods, acceptanceCriteria, and risks.",
  "Always prohibit formal file modification and dangerous operations before plan approval.",
  "Always prohibit Firstmate from generating formal Artifacts.",
  "Respond with JSON that matches the provided schema."
].join("\n");
