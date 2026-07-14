import {
  getProviderPreset,
  isProviderKind,
  type ProviderKind,
  type ProviderPreset
} from "./presets.js";

export type ModelSource = "manual" | "discovered";

export interface ProviderConfigInput {
  presetId?: string;
  providerKind?: string;
  baseUrl?: string;
  modelId?: string;
  modelSource?: string;
  apiKey?: string;
  /** When true, missing apiKey is OK if a credential is already stored. */
  hasExistingCredential?: boolean;
  enabled?: boolean;
  name?: string;
}

export interface ValidatedProviderConfig {
  presetId: string;
  providerKind: ProviderKind;
  baseUrl: string;
  modelId: string;
  modelSource: ModelSource;
  /** Normalized secret when provided; undefined means leave vault unchanged. */
  apiKey?: string;
  enabled: boolean;
  name?: string;
  preset: ProviderPreset;
}

/**
 * Schema validation for provider + connection combinations.
 * Rejects illegal enums and incompatible preset/URL/credential combos before write.
 */
export function validateProviderConfig(input: ProviderConfigInput): ValidatedProviderConfig {
  const presetId = (input.presetId?.trim() || "custom");
  const preset = getProviderPreset(presetId);
  if (!preset) {
    throw new Error(
      `Invalid provider preset "${presetId}". Allowed: ${listAllowedPresetIds().join(", ")}.`
    );
  }

  let providerKind: ProviderKind = preset.kind;
  if (input.providerKind !== undefined && input.providerKind.trim() !== "") {
    if (!isProviderKind(input.providerKind)) {
      throw new Error(
        `Invalid provider kind "${input.providerKind}". Allowed: openai, openai_compatible, azure_openai, ollama, custom.`
      );
    }
    if (input.providerKind !== preset.kind) {
      throw new Error(
        `Provider kind "${input.providerKind}" is incompatible with preset "${preset.id}" (expected "${preset.kind}").`
      );
    }
    providerKind = input.providerKind;
  }

  let modelSource: ModelSource = "manual";
  if (input.modelSource !== undefined && input.modelSource.trim() !== "") {
    if (input.modelSource !== "manual" && input.modelSource !== "discovered") {
      throw new Error('modelSource must be "manual" or "discovered".');
    }
    modelSource = input.modelSource;
  }

  const baseUrl = resolveBaseUrl(input.baseUrl, preset);
  const modelId = required(input.modelId, "A model ID is required.");

  let apiKey: string | undefined;
  if (input.apiKey !== undefined) {
    const trimmed = input.apiKey.trim();
    if (trimmed) {
      apiKey = trimmed;
    } else if (preset.requiresCredential && !input.hasExistingCredential) {
      throw new Error("An API Key is required for this provider preset.");
    }
  } else if (preset.requiresCredential && !input.hasExistingCredential) {
    // create path without apiKey field
    throw new Error("An API Key is required for this provider preset.");
  }

  // Incompatible combos
  if (providerKind === "azure_openai" && !/azure|openai\.azure|cognitiveservices/i.test(baseUrl) && !input.baseUrl?.trim()) {
    // If user supplied explicit URL we accept; if they used empty we already threw.
  }
  if (providerKind === "ollama" && preset.authStyle === "none" && apiKey === undefined) {
    // OK
  }
  if (providerKind === "openai" && !preset.allowCustomBaseUrl) {
    const expected = preset.defaultBaseUrl!.replace(/\/$/, "");
    if (baseUrl !== expected) {
      throw new Error(`OpenAI preset Base URL is fixed to ${expected}. Use a custom/compatible preset to override.`);
    }
  }
  if (modelSource === "discovered" && !preset.supportsModelList) {
    throw new Error(`Preset "${preset.id}" does not support dynamic model discovery; use manual model ID.`);
  }

  const enabled = input.enabled ?? true;
  const name = input.name?.trim() || undefined;

  return {
    presetId: preset.id,
    providerKind,
    baseUrl,
    modelId,
    modelSource,
    apiKey,
    enabled,
    name,
    preset
  };
}

function resolveBaseUrl(value: string | undefined, preset: ProviderPreset): string {
  const raw = value?.trim();
  if (!raw) {
    if (preset.defaultBaseUrl) {
      return normalizeBaseUrl(preset.defaultBaseUrl);
    }
    throw new Error("A Base URL is required.");
  }
  if (!preset.allowCustomBaseUrl && preset.defaultBaseUrl) {
    const normalized = normalizeBaseUrl(raw);
    const expected = normalizeBaseUrl(preset.defaultBaseUrl);
    if (normalized !== expected) {
      throw new Error(
        `Preset "${preset.id}" does not allow custom Base URL (fixed to ${expected}).`
      );
    }
    return expected;
  }
  return normalizeBaseUrl(raw);
}

export function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(required(value, "A Base URL is required."));
  } catch {
    throw new Error("Base URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Base URL must be a valid HTTP(S) URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function required(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function listAllowedPresetIds(): string[] {
  return ["custom", "openai", "openai_compatible", "azure_openai", "ollama"];
}
