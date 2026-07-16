/**
 * /api/providers/* — shared by PWA and pawb CLI (task 05 / 05A).
 * Responses never include secrets.
 */

import type { Express, Request, Response } from "express";
import type { ProviderService } from "./providerService.js";
import type { CreateProviderInput, ProviderAdapterKind, ProviderAuthMode } from "./providerTypes.js";

export function mountProviderApiRoutes(app: Express, providers: ProviderService): void {
  app.get("/api/providers", async (request, response) => {
    try {
      const detailed = request.query.detailed === "1" || request.query.detailed === "true";
      response.json(detailed ? await providers.listDetailed() : await providers.list());
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to list providers.") });
    }
  });

  // CLI catalog (avoid clashing with legacy GET /api/providers/presets from mountProviderRoutes).
  app.get("/api/providers/catalog", (_request, response) => {
    response.json(providers.listPresets());
  });

  app.get("/api/providers/oauth/supported", async (_request, response) => {
    try {
      const { listSupportedOAuthProviders } = await import("./oauthCredentials.js");
      response.json({
        providers: listSupportedOAuthProviders(),
        note: "Interactive login runs in pawb CLI; tokens are stored via POST /api/providers/:id/oauth/complete."
      });
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to list OAuth providers.") });
    }
  });

  app.post("/api/providers", async (request, response) => {
    try {
      const body = request.body ?? {};
      // Reject CLI-style plaintext flags in body dump safety
      if (typeof body["api-key"] === "string" || typeof body.api_key_flag === "string") {
        return response.status(400).json({
          error: "Do not pass API keys via alternate field names; use apiKey only over localhost HTTPS/loopback."
        });
      }
      const models = Array.isArray(body.models)
        ? body.models.map((m: Record<string, unknown>) => ({
            remoteModelId: String(m.remoteModelId ?? m.id ?? ""),
            displayName: typeof m.displayName === "string" ? m.displayName : undefined,
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
            maxOutputTokens: typeof m.maxOutputTokens === "number" ? m.maxOutputTokens : undefined,
            supportsReasoning: m.supportsReasoning === true || m.reasoning === true
          }))
        : undefined;
      const input: CreateProviderInput = {
        name: String(body.name ?? ""),
        adapter: body.adapter as ProviderAdapterKind,
        providerType: body.providerType,
        baseUrl: optionalString(body.baseUrl),
        apiProtocol: optionalString(body.apiProtocol),
        authMode: body.authMode as ProviderAuthMode,
        apiKey: optionalString(body.apiKey),
        credentialEnvVar: optionalString(body.credentialEnvVar),
        defaultModelId: optionalString(body.defaultModelId),
        enabled: body.enabled !== false,
        discoverModels: body.discoverModels === true ? true : body.discoverModels === false ? false : undefined,
        allowDeferredCredential: body.allowDeferredCredential === true,
        models
      };
      const created = await providers.create(input);
      response.status(201).json(created);
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to create provider.") });
    }
  });

  app.get("/api/providers/:id", async (request, response) => {
    try {
      response.json(await providers.get(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Provider not found.") });
    }
  });

  app.patch("/api/providers/:id", async (request, response) => {
    try {
      response.json(
        await providers.update(routeParam(request.params.id), {
          name: optionalString(request.body?.name),
          baseUrl: optionalString(request.body?.baseUrl),
          authMode: request.body?.authMode,
          apiKey: optionalString(request.body?.apiKey),
          credentialEnvVar: optionalString(request.body?.credentialEnvVar),
          defaultModelId: optionalString(request.body?.defaultModelId),
          enabled: typeof request.body?.enabled === "boolean" ? request.body.enabled : undefined
        })
      );
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to update provider.") });
    }
  });

  app.delete("/api/providers/:id", async (request, response) => {
    try {
      await providers.remove(routeParam(request.params.id));
      response.status(204).end();
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to remove provider.") });
    }
  });

  app.post("/api/providers/:id/credential", async (request, response) => {
    try {
      const apiKey = optionalString(request.body?.apiKey);
      if (!apiKey) return response.status(400).json({ error: "apiKey is required." });
      response.json(await providers.setCredential(routeParam(request.params.id), apiKey));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to set credential.") });
    }
  });

  app.delete("/api/providers/:id/credential", async (request, response) => {
    try {
      response.json(await providers.clearCredential(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to clear credential.") });
    }
  });

  app.post("/api/providers/:id/test", async (request, response) => {
    try {
      response.json(await providers.test(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to test provider.") });
    }
  });

  app.post("/api/providers/:id/models/discover", async (request, response) => {
    try {
      response.json(await providers.discoverModels(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to discover models.") });
    }
  });

  app.get("/api/providers/:id/models", async (request, response) => {
    try {
      response.json(await providers.listModels(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to list models.") });
    }
  });

  app.post("/api/providers/:id/models", async (request, response) => {
    try {
      response.status(201).json(
        await providers.addModel(routeParam(request.params.id), {
          remoteModelId: String(request.body?.remoteModelId ?? ""),
          displayName: optionalString(request.body?.displayName),
          contextWindow: typeof request.body?.contextWindow === "number" ? request.body.contextWindow : undefined,
          supportsReasoning: request.body?.supportsReasoning === true
        })
      );
    } catch (error) {
      response.status(400).json({ error: message(error, "Unable to add model.") });
    }
  });

  app.post("/api/providers/:id/oauth/start", async (request, response) => {
    try {
      response.json(await providers.startOAuth(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to start OAuth.") });
    }
  });

  /**
   * Complete OAuth after CLI interactive login.
   * Body: { oauthProviderId, credentials: { access, refresh, expires, ... } }
   * Never echoes secrets back.
   */
  app.post("/api/providers/:id/oauth/complete", async (request, response) => {
    try {
      const body = request.body ?? {};
      const oauthProviderId = String(body.oauthProviderId ?? body.provider ?? "");
      const credentials = body.credentials ?? body;
      const created = await providers.completeOAuth(routeParam(request.params.id), {
        oauthProviderId,
        credentials: {
          access: String(credentials.access ?? ""),
          refresh: String(credentials.refresh ?? ""),
          expires: Number(credentials.expires),
          ...Object.fromEntries(
            Object.entries(credentials).filter(
              ([k]) => !["access", "refresh", "expires", "type", "oauthProviderId"].includes(k)
            )
          )
        }
      });
      // Strip any accidental secret fields
      response.json({
        id: created.id,
        name: created.name,
        authMode: created.authMode,
        credentialConfigured: created.credentialConfigured,
        status: created.status,
        lastTestMessage: created.lastTestMessage
      });
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to complete OAuth.") });
    }
  });

  app.post("/api/providers/:id/logout", async (request, response) => {
    try {
      response.json(await providers.logout(routeParam(request.params.id)));
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error, "Unable to logout provider.") });
    }
  });

  // Harness status helper for Codex (task 10 note)
  app.get("/api/harness/status/:name", async (request, response) => {
    const name = routeParam(request.params.name).toLowerCase();
    if (name !== "codex") {
      return response.status(404).json({ error: `Unknown harness: ${name}` });
    }
    // Codex login is independent of OpenAI API provider credentials.
    response.json({
      harness: "codex",
      note: "Codex CLI login is separate from OpenAI API Provider credentials.",
      check: "Use GET /api/codex-cli/status for install/login probe."
    });
  });
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusFor(error: unknown): number {
  const msg = message(error, "");
  if (/not found/i.test(msg)) return 404;
  return 400;
}
