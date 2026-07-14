/**
 * Plugin / Extension SDK (Task 46).
 * Stable extension surface for Provider, Harness, Tool, Skill Source,
 * Artifact Renderer, and Trigger — without modifying core for each new capability.
 */

export {
  PLUGIN_API_VERSION,
  PLUGIN_CONTRIBUTION_KINDS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PERMISSIONS,
  type ArtifactRendererContribution,
  type EnablePluginInput,
  type HarnessContribution,
  type InprocessPluginModule,
  type InstallPluginInput,
  type PluginBackupSlice,
  type PluginCompatResult,
  type PluginContributionKind,
  type PluginContributes,
  type PluginEngineCompat,
  type PluginEntryType,
  type PluginHostRequest,
  type PluginHostResponse,
  type PluginInstallRecord,
  type PluginInstallStatus,
  type PluginJsonSchema,
  type PluginManifest,
  type PluginMessageHandler,
  type PluginPermission,
  type PluginPermissionDenial,
  type PluginServerConfig,
  type PluginState,
  type PluginTriggerKind,
  type PluginVersionSnapshot,
  type ProviderContribution,
  type PublicPluginRecord,
  type RegisteredContribution,
  type ResolvedPluginManifest,
  type RollbackPluginInput,
  type RunningPluginHandle,
  type SkillSourceContribution,
  type ToolContribution,
  type TriggerContribution,
  type UpdatePluginInput
} from "./pluginTypes.js";

export {
  checkPluginCompatibility,
  compareSemverLike,
  isApiVersionCompatible,
  isEngineCompatible
} from "./pluginCompat.js";

export {
  PluginPermissionError,
  assertPermission,
  hasPermission,
  isPluginPermission,
  normalizePermissions,
  permissionForContribution,
  validatePermissionApproval
} from "./pluginPermissions.js";

export {
  PluginManifestError,
  cloneContributes,
  hashPluginPackage,
  loadPluginManifest,
  parsePluginManifest
} from "./pluginManifest.js";

export {
  PluginHost,
  PluginHostError,
  createStdioPluginRuntime,
  type PluginCrashHandler,
  type PluginHostOptions
} from "./pluginHost.js";

export { PluginContributionRegistry } from "./pluginRegistry.js";

export {
  MemoryPluginVault,
  PluginService,
  type CredentialVault,
  type PluginServiceOptions
} from "./pluginService.js";
