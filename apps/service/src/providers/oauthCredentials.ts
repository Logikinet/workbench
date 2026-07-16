/**
 * OAuth credential storage helpers.
 * Tokens live only in CredentialVault (JSON blob); meta JSON never stores secrets.
 *
 * Login UI runs in the CLI via @earendil-works/pi-ai/oauth; Service stores + refreshes.
 */

import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials
} from "@earendil-works/pi-ai/oauth";

export type StoredOAuthBlob = OAuthCredentials & {
  type: "oauth";
  /** pi-ai OAuth provider id (anthropic | openai-codex | github-copilot | radius). */
  oauthProviderId: string;
};

export function listSupportedOAuthProviders(): Array<{ id: string; name: string }> {
  return getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
}

export function isOAuthProviderSupported(id: string): boolean {
  return Boolean(getOAuthProvider(id));
}

export function encodeOAuthSecret(
  oauthProviderId: string,
  credentials: OAuthCredentials
): string {
  if (!isOAuthProviderSupported(oauthProviderId)) {
    throw new Error(
      `Unsupported OAuth provider '${oauthProviderId}'. Supported: ${listSupportedOAuthProviders()
        .map((p) => p.id)
        .join(", ")}.`
    );
  }
  const blob: StoredOAuthBlob = {
    type: "oauth",
    oauthProviderId,
    refresh: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    ...Object.fromEntries(
      Object.entries(credentials).filter(
        ([k]) => !["type", "oauthProviderId", "refresh", "access", "expires"].includes(k)
      )
    )
  };
  return JSON.stringify(blob);
}

export function tryParseOAuthSecret(raw: string | null | undefined): StoredOAuthBlob | null {
  if (!raw?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredOAuthBlob>;
    if (
      parsed?.type === "oauth" &&
      typeof parsed.oauthProviderId === "string" &&
      typeof parsed.access === "string" &&
      typeof parsed.refresh === "string" &&
      typeof parsed.expires === "number"
    ) {
      return parsed as StoredOAuthBlob;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a bearer/API token from vault material.
 * Refreshes OAuth when expired; returns updated secret string when refresh occurred.
 */
export async function resolveAccessTokenFromVaultSecret(
  raw: string
): Promise<{ token: string; updatedSecret?: string; source: "oauth" | "api-key" }> {
  const oauth = tryParseOAuthSecret(raw);
  if (!oauth) {
    return { token: raw, source: "api-key" };
  }

  const map: Record<string, OAuthCredentials> = {
    [oauth.oauthProviderId]: {
      refresh: oauth.refresh,
      access: oauth.access,
      expires: oauth.expires,
      ...Object.fromEntries(
        Object.entries(oauth).filter(
          ([k]) => !["type", "oauthProviderId", "refresh", "access", "expires"].includes(k)
        )
      )
    }
  };

  const result = await getOAuthApiKey(oauth.oauthProviderId, map);
  if (!result) {
    throw new Error(`OAuth credentials missing for ${oauth.oauthProviderId}.`);
  }

  const changed =
    result.newCredentials.access !== oauth.access ||
    result.newCredentials.refresh !== oauth.refresh ||
    result.newCredentials.expires !== oauth.expires;

  return {
    token: result.apiKey,
    source: "oauth",
    updatedSecret: changed
      ? encodeOAuthSecret(oauth.oauthProviderId, result.newCredentials)
      : undefined
  };
}
