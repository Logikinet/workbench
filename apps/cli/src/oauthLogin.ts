/**
 * Interactive OAuth login (todos-style), driven in the CLI process.
 * Uses @earendil-works/pi-ai/oauth for Anthropic / OpenAI Codex / GitHub Copilot / Radius.
 * Tokens are never printed; caller posts them to Agent Service for vault storage.
 */

import { spawn } from "node:child_process";
import { stdout as output } from "node:process";
import {
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials
} from "@earendil-works/pi-ai/oauth";
import { promptLine, promptSelect } from "./prompt.js";

export function listCliOAuthProviders(): Array<{ id: string; name: string }> {
  return getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
}

export function isCliOAuthSupported(providerId: string): boolean {
  return Boolean(getOAuthProvider(providerId));
}

/** Map catalog / connection name → pi-ai OAuth provider id when possible. */
export function resolveOAuthProviderId(idOrName: string): string | undefined {
  const raw = idOrName.trim().toLowerCase();
  if (getOAuthProvider(raw)) return raw;
  const aliases: Record<string, string> = {
    "claude": "anthropic",
    "claude-pro": "anthropic",
    "claude-max": "anthropic",
    "chatgpt": "openai-codex",
    codex: "openai-codex",
    "openai-codex": "openai-codex",
    copilot: "github-copilot",
    "github-copilot": "github-copilot",
    github: "github-copilot"
  };
  const mapped = aliases[raw];
  if (mapped && getOAuthProvider(mapped)) return mapped;
  // fuzzy by label
  const hit = getOAuthProviders().find(
    (p) => p.id === raw || p.name.toLowerCase().includes(raw) || raw.includes(p.id)
  );
  return hit?.id;
}

/**
 * Run full interactive OAuth for a supported provider.
 * Opens browser when auth URL is issued; supports device-code + paste-code paths.
 */
export async function runInteractiveOAuthLogin(providerId: string): Promise<{
  oauthProviderId: string;
  credentials: OAuthCredentials;
}> {
  const oauthId = resolveOAuthProviderId(providerId);
  if (!oauthId) {
    const supported = listCliOAuthProviders()
      .map((p) => p.id)
      .join(", ");
    throw new Error(
      `OAuth is not available for '${providerId}'. Supported subscription logins: ${supported}. Use API key for other providers.`
    );
  }

  const provider = getOAuthProvider(oauthId);
  if (!provider) {
    throw new Error(`OAuth provider '${oauthId}' is not registered.`);
  }

  output.write(`[provider] Starting OAuth login for '${oauthId}' (${provider.name})...\n`);
  output.write("[auth] A browser window may open. Complete sign-in, then return here if prompted.\n");

  const credentials = await provider.login({
    onAuth: (info) => {
      output.write(`\n[auth] Open: ${info.url}\n`);
      if (info.instructions) output.write(`[auth] ${info.instructions}\n`);
      void openBrowser(info.url);
    },
    onDeviceCode: (info) => {
      output.write(`\n[auth] Open: ${info.verificationUri}\n`);
      output.write(`[auth] Code: ${info.userCode}\n`);
      if (info.expiresInSeconds) {
        output.write(`[auth] Code expires in ~${Math.round(info.expiresInSeconds / 60)} min\n`);
      }
      void openBrowser(info.verificationUri);
    },
    onProgress: (msg) => {
      output.write(`[auth] ${msg}\n`);
    },
    onSelect: async (prompt) => {
      try {
        return await promptSelect(
          prompt.message,
          prompt.options.map((o) => ({ id: o.id, label: o.label }))
        );
      } catch {
        return undefined;
      }
    },
    onPrompt: async (prompt) => {
      const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
      return promptLine(`${prompt.message}${placeholder}`);
    },
    onManualCodeInput: async () => {
      return promptLine(
        "Paste authorization code or full redirect URL (or wait for browser callback)"
      );
    },
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });

  if (!credentials?.access || !credentials?.refresh) {
    throw new Error("OAuth login did not return access/refresh tokens.");
  }

  output.write(`[provider] Logged in to '${oauthId}'.\n`);
  return { oauthProviderId: oauthId, credentials };
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // non-fatal — user can open URL manually
  }
}
