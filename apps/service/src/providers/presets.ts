/**
 * Built-in Provider presets. No default relay is implied — users always choose.
 * Secrets are never part of a preset; only non-sensitive metadata lives here.
 */

export const providerKinds = [
  "openai",
  "openai_compatible",
  "azure_openai",
  "ollama",
  "custom"
] as const;

export type ProviderKind = (typeof providerKinds)[number];

export const authStyles = ["bearer", "api_key_header", "none"] as const;
export type AuthStyle = (typeof authStyles)[number];

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Suggested Base URL; empty when the user must supply one. */
  defaultBaseUrl?: string;
  /** Whether Base URL may be overridden for this preset. */
  allowCustomBaseUrl: boolean;
  /** Whether /v1/models-style listing is expected to work. */
  supportsModelList: boolean;
  /** Whether a usage snapshot endpoint is worth probing. */
  supportsUsage: boolean;
  authStyle: AuthStyle;
  /** When true, create/update requires a non-empty API Key. */
  requiresCredential: boolean;
  description: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "custom",
    name: "自定义 OpenAI-compatible",
    kind: "custom",
    allowCustomBaseUrl: true,
    supportsModelList: true,
    supportsUsage: false,
    authStyle: "bearer",
    requiresCredential: true,
    description: "任意 OpenAI 兼容中转站、官方 API 或本地网关。完全由用户填写 Base URL。"
  },
  {
    id: "openai",
    name: "OpenAI 官方",
    kind: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    allowCustomBaseUrl: false,
    supportsModelList: true,
    supportsUsage: true,
    authStyle: "bearer",
    requiresCredential: true,
    description: "OpenAI 官方 Chat Completions API。"
  },
  {
    id: "openai_compatible",
    name: "OpenAI-compatible 通用",
    kind: "openai_compatible",
    allowCustomBaseUrl: true,
    supportsModelList: true,
    supportsUsage: false,
    authStyle: "bearer",
    requiresCredential: true,
    description: "通用 OpenAI 兼容端点（含多数中转站）。"
  },
  {
    id: "azure_openai",
    name: "Azure OpenAI",
    kind: "azure_openai",
    allowCustomBaseUrl: true,
    supportsModelList: true,
    supportsUsage: false,
    authStyle: "api_key_header",
    requiresCredential: true,
    description: "Azure OpenAI 资源端点。必须填写资源 Base URL；模型 ID 为部署名。"
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    kind: "ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    allowCustomBaseUrl: true,
    supportsModelList: true,
    supportsUsage: false,
    authStyle: "none",
    requiresCredential: false,
    description: "本机 Ollama OpenAI 兼容接口。通常无需 API Key。"
  }
] as const;

const presetById = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function listProviderPresets(): ProviderPreset[] {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset }));
}

export function getProviderPreset(presetId: string): ProviderPreset | undefined {
  return presetById.get(presetId);
}

export function requireProviderPreset(presetId: string): ProviderPreset {
  const preset = getProviderPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset "${presetId}".`);
  }
  return preset;
}

export function isProviderKind(value: string): value is ProviderKind {
  return (providerKinds as readonly string[]).includes(value);
}

export function isAuthStyle(value: string): value is AuthStyle {
  return (authStyles as readonly string[]).includes(value);
}
