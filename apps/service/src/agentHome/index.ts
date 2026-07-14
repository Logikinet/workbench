export {
  HOME_PROFILE_FILES,
  MEMORY_LAYERS,
  type AgentHomeDescriptor,
  type AgentHomeMeta,
  type HomeKind,
  type HomeProfileFile,
  type HomeSkillSummary,
  type LoadedHomeContext,
  type LoadHomeContextOptions,
  type MemoryConfidence,
  type MemoryEntry,
  type MemoryLayer,
  type PromoteTempHomeInput,
  type SharedHomeExport,
  type TemplateDiffResult,
  type TemplateFileDiff,
  type WriteMemoryInput
} from "./agentHomeTypes.js";

export {
  CURRENT_TEMPLATE_VERSION,
  allDefaultTemplates,
  defaultTemplateContent,
  migrateTemplates,
  type TemplateRenderContext
} from "./homeTemplates.js";

export {
  FIRSTMATE_HARD_RULES,
  assertHomeCannotOverrideHardRules,
  composeWithHardRules,
  detectHardRuleOverrides,
  type HardRuleViolation
} from "./firstmateHardRules.js";

export {
  AgentHomeService,
  type AgentHomeServiceOptions
} from "./agentHomeService.js";
