import type { VerificationTaskType } from "./types.js";

export const taskTypes = [
  "implementation",
  "bug_fix",
  "research",
  "writing",
  "analysis",
  "automation",
  "other"
] as const satisfies readonly VerificationTaskType[];

export type { VerificationTaskType };
