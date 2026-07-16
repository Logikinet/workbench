export {
  PROVIDER_PRESETS,
  listProviderPresets,
  getProviderPreset,
  requireProviderPreset,
  isProviderKind,
  isAuthStyle,
  providerKinds,
  authStyles,
  type ProviderKind,
  type AuthStyle,
  type ProviderPreset
} from "./presets.js";

export {
  validateProviderConfig,
  normalizeBaseUrl,
  type ProviderConfigInput,
  type ValidatedProviderConfig,
  type ModelSource
} from "./schema.js";

export {
  ConfigHotReloader,
  type ConfigChangeAction,
  type ConfigChangeEvent,
  type ConfigChangeListener
} from "./hotReload.js";

export { ProviderService, type ProviderServiceOptions } from "./providerService.js";
export { mountProviderApiRoutes } from "./providerApiRoutes.js";
export { getProviderAdapter } from "./providerAdapters.js";
export { PROVIDER_CLI_PRESETS } from "./providerCatalog.js";
export {
  type ProviderConnection,
  type ProviderModel,
  type ProviderTestResult,
  type CreateProviderInput,
  type ProviderAdapterKind,
  type ProviderAuthMode,
  type ProviderStatus,
  type ProviderPresetChoice
} from "./providerTypes.js";
