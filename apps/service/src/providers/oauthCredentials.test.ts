import { describe, expect, it } from "vitest";
import {
  encodeOAuthSecret,
  isOAuthProviderSupported,
  listSupportedOAuthProviders,
  tryParseOAuthSecret
} from "./oauthCredentials.js";

describe("oauthCredentials", () => {
  it("lists built-in subscription OAuth providers from pi-ai", () => {
    const list = listSupportedOAuthProviders();
    const ids = list.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("github-copilot");
    expect(isOAuthProviderSupported("anthropic")).toBe(true);
    expect(isOAuthProviderSupported("not-a-real-provider")).toBe(false);
  });

  it("round-trips OAuth secrets without leaking structure errors", () => {
    const secret = encodeOAuthSecret("anthropic", {
      access: "access-token-value",
      refresh: "refresh-token-value",
      expires: Date.now() + 60_000
    });
    expect(secret).not.toMatch(/sk-/);
    const parsed = tryParseOAuthSecret(secret);
    expect(parsed?.type).toBe("oauth");
    expect(parsed?.oauthProviderId).toBe("anthropic");
    expect(parsed?.access).toBe("access-token-value");
    expect(parsed?.refresh).toBe("refresh-token-value");
  });

  it("does not treat plain api keys as oauth blobs", () => {
    expect(tryParseOAuthSecret("sk-plain-key")).toBeNull();
    expect(tryParseOAuthSecret('{"foo":1}')).toBeNull();
  });

  it("rejects unknown oauth provider ids on encode", () => {
    expect(() =>
      encodeOAuthSecret("not-supported", {
        access: "a",
        refresh: "r",
        expires: 1
      })
    ).toThrow(/Unsupported OAuth/);
  });
});
