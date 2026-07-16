/**
 * pawb provider — API/Provider 配置交互对齐 todos-dev CLI（tds provider）。
 *
 * 行为参考（不复制私有代码）：
 *  - 主菜单：Add / List / Remove / Exit
 *  - 预设搜索 → 内置仅认证；Custom/Ollama 走 name + baseUrl + 多模型
 *  - API key：$ENV_VAR / !shell-command / 遮罩明文；禁止 --api-key 标志
 *  - Custom 允许 empty skip → 稍后 login
 *
 * 架构：只调用 localhost Agent Service，不写 models.json / SQLite。
 */

import { stdout as output } from "node:process";
import { apiJson, apiVoid, ServiceOfflineError } from "./client.js";
import {
  isCliOAuthSupported,
  listCliOAuthProviders,
  resolveOAuthProviderId,
  runInteractiveOAuthLogin
} from "./oauthLogin.js";
import {
  promptConfirm,
  promptLine,
  promptSearchSelect,
  promptSecretIndirection,
  promptSelect
} from "./prompt.js";
import { assertNoApiKeyFlag, redactSecrets } from "./redact.js";

interface ProviderRow {
  id: string;
  name: string;
  adapter: string;
  authMode: string;
  baseUrl?: string;
  credentialConfigured: boolean;
  enabled: boolean;
  status: string;
  defaultModelId?: string;
  lastTestMessage?: string;
  providerType?: string;
  models?: Array<{ remoteModelId: string; displayName?: string }>;
  type?: string;
  authLabel?: string;
}

interface CatalogPreset {
  id: string;
  name: string;
  label: string;
  hint: string;
  adapter: string;
  providerType: string;
  defaultBaseUrl?: string;
  apiProtocol: string;
  authModes: string[];
  requiresCredential: boolean;
  allowDeferredCredential: boolean;
  description: string;
  credentialEnvVar?: string;
  defaultModelId?: string;
}

interface TestResult {
  status: string;
  message: string;
  modelCount?: number;
}

interface ModelDraft {
  remoteModelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
}

export async function runProviderCommand(argv: string[]): Promise<number> {
  assertNoApiKeyFlag(argv);
  const sub = argv[0]?.toLowerCase();

  try {
    if (!sub || sub === "menu" || sub === "interactive") {
      return await interactiveMenu();
    }
    if (sub === "help" || sub === "-h" || sub === "--help") {
      printHelp();
      return 0;
    }
    if (sub === "add") return await addProvider(argv.slice(1));
    if (sub === "list") return await listProviders(argv.slice(1));
    if (sub === "test") return await testProvider(argv[1]);
    if (sub === "remove" || sub === "rm") return await removeProvider(argv[1], argv.slice(2));
    if (sub === "login") return await loginProvider(argv[1]);
    if (sub === "logout") return await logoutProvider(argv[1]);
    // Unknown sub → menu (todos fails; we fall through to menu for friendliness)
    output.write(`Unknown subcommand: ${sub}\n`);
    printHelp();
    return 1;
  } catch (error) {
    if (error instanceof ServiceOfflineError) {
      output.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof Error && error.message === "Cancelled.") {
      output.write("[provider] Cancelled.\n");
      return 0;
    }
    output.write(`错误：${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

function printHelp(): void {
  output.write(`Usage: pawb provider <add|list|remove|test|login|logout> [options]

Manage the AI providers and models this machine can use.
(Aligned with todos CLI UX; all writes go through Local Agent Service.)

Subcommands:
  add              Add a provider (API key or OAuth login)
  list             List configured providers
  remove           Remove a provider
  test <id>        Test connection (workbench extra)
  login <id>       Update credentials / API key / OAuth
  logout <id>      Clear credentials (workbench extra)

Subscription OAuth (interactive, todos-style):
  anthropic        Claude Pro/Max (browser + PKCE)
  openai-codex     ChatGPT Plus/Pro Codex (browser or device code)
  github-copilot   GitHub Copilot (device code)
  radius           Radius gateway

API Key input (interactive):
  paste literal key (masked)
  $ENV_VAR         read from environment
  !shell-command   capture secret from shell stdout

Security:
  --api-key / -k plaintext flags are forbidden.
  OAuth tokens are stored only in the Agent Service vault.
  List / JSON never include secrets.
`);
}

/** todos: What do you want to do? → Add / List / Remove / Exit */
async function interactiveMenu(): Promise<number> {
  output.write("\nManage AI providers and models\n");
  for (;;) {
    const action = await promptSelect("What do you want to do?", [
      { id: "add", label: "Add provider" },
      { id: "list", label: "List providers" },
      { id: "remove", label: "Remove a provider" },
      { id: "test", label: "Test a provider", hint: "workbench" },
      { id: "login", label: "Update credentials", hint: "login" },
      { id: "logout", label: "Clear credentials", hint: "logout" },
      { id: "exit", label: "Exit" }
    ]);
    if (action === "exit") return 0;
    try {
      if (action === "add") await addProvider([]);
      else if (action === "list") await listProviders([]);
      else if (action === "remove") await removeProvider(undefined, []);
      else if (action === "test") await testProvider(await pickProviderId("Test which provider?"));
      else if (action === "login") await loginProvider(await pickProviderId("Login which provider?"));
      else if (action === "logout") await logoutProvider(await pickProviderId("Logout which provider?"));
      // todos menu returns after one action; keep looping for convenience
    } catch (error) {
      if (error instanceof Error && error.message === "Cancelled.") {
        output.write("[provider] Back to menu.\n");
        continue;
      }
      throw error;
    }
  }
}

/** todos table: PROVIDER  TYPE  AUTH  MODELS */
async function listProviders(args: string[]): Promise<number> {
  const asJson = args.includes("--json") || args.includes("-j");
  const list = await apiJson<ProviderRow[]>("/api/providers?detailed=1");

  if (asJson) {
    const safe = list.map((p) => ({
      provider: p.name,
      id: p.id,
      type: p.providerType ?? p.type ?? "custom",
      auth: p.authLabel ?? (p.credentialConfigured || p.authMode === "none" ? "ok" : "-"),
      authMode: p.authMode,
      status: p.status,
      baseUrl: p.baseUrl,
      models: (p.models ?? []).map((m) => m.remoteModelId)
    }));
    output.write(`${JSON.stringify(safe, null, 2)}\n`);
    return 0;
  }

  if (list.length === 0) {
    output.write("No configured providers. Run: pawb provider add\n");
    return 0;
  }

  const rows = list.map((p) => {
    const models = (p.models ?? []).map((m) => m.remoteModelId);
    const modelCol =
      models.length === 0
        ? p.defaultModelId ?? "-"
        : models.slice(0, 3).join(", ") + (models.length > 3 ? `, +${models.length - 3} more` : "");
    return {
      provider: p.name,
      type: p.providerType ?? p.type ?? "custom",
      auth: p.authLabel ?? (p.credentialConfigured || p.authMode === "none" || p.authMode === "environment" ? "ok" : "-"),
      models: modelCol
    };
  });

  const headers = ["PROVIDER", "TYPE", "AUTH", "MODELS"] as const;
  const cells = rows.map((r) => [r.provider, r.type, r.auth, r.models]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  output.write(headers.map((h, i) => pad(h, widths[i]!)).join("  ") + "\n");
  for (const row of cells) {
    output.write(row.map((c, i) => pad(String(c), widths[i]!)).join("  ") + "\n");
  }
  return 0;
}

/**
 * todos addProvider:
 *   built-in → auth only (oauth | api-key)
 *   custom/ollama → name, baseUrl, optional key, multi-model
 */
async function addProvider(args: string[]): Promise<number> {
  const flags = parseSimpleFlags(args);
  const yes = flags.bools.has("yes") || flags.bools.has("y");

  const catalog = await apiJson<CatalogPreset[]>("/api/providers/catalog");
  const presetId =
    flags.values.get("preset") ??
    (yes
      ? (() => {
          throw new Error("error: missing --preset (required with --yes)");
        })()
      : await promptSearchSelect(
          "Pick a preset (type to search)",
          catalog.map((p) => ({
            id: p.id,
            label: p.label || p.name,
            hint: p.hint || p.description
          }))
        ));

  const preset = catalog.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset: ${presetId}`);

  const isBuiltIn = preset.providerType === "builtin";

  if (isBuiltIn) {
    return await addBuiltInProvider(preset, flags, yes);
  }
  return await addCustomStyleProvider(preset, flags, yes);
}

/** todos addBuiltInProvider — only auth */
async function addBuiltInProvider(
  preset: CatalogPreset,
  flags: ParsedFlags,
  yes: boolean
): Promise<number> {
  const method = await resolveAuthMethod(preset, flags, yes);

  if (method === "oauth") {
    if (yes) {
      throw new Error(`OAuth login for '${preset.id}' is interactive. Rerun without --yes.`);
    }
    const oauthId = resolveOAuthProviderId(preset.id);
    if (!oauthId || !isCliOAuthSupported(oauthId)) {
      const supported = listCliOAuthProviders()
        .map((p) => p.id)
        .join(", ");
      throw new Error(
        `OAuth is not available for '${preset.id}'. Supported: ${supported}. Choose API key instead.`
      );
    }

    // 1) Interactive OAuth in CLI (browser / device code) — todos-style
    const { oauthProviderId, credentials } = await runInteractiveOAuthLogin(oauthId);

    // 2) Create provider shell on Service
    output.write("Validating / saving…\n");
    const created = await apiJson<ProviderRow>("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: preset.name,
        adapter: preset.adapter,
        providerType: preset.providerType,
        baseUrl: preset.defaultBaseUrl,
        apiProtocol: preset.apiProtocol,
        authMode: "oauth",
        allowDeferredCredential: true,
        discoverModels: true,
        defaultModelId: preset.defaultModelId || "default"
      })
    });

    // 3) Store tokens in vault via Service
    const done = await apiJson<{
      id: string;
      name: string;
      status: string;
      credentialConfigured: boolean;
      lastTestMessage?: string;
    }>(`/api/providers/${encodeURIComponent(created.id)}/oauth/complete`, {
      method: "POST",
      body: JSON.stringify({ oauthProviderId, credentials })
    });

    output.write(`[provider] OAuth credentials stored for '${done.name}'.\n`);
    if (done.lastTestMessage) {
      output.write(`[provider] ${redactSecrets(done.lastTestMessage)}\n`);
    }
    output.write(`[provider] Synced to Agent Service / PWA (id=${done.id}, status=${done.status}).\n`);
    return done.credentialConfigured || done.status === "ready" ? 0 : 0;
  }

  // api-key (or resolved from $ENV → environment)
  let apiKey: string | undefined;
  let authMode: string = "api-key";
  let credentialEnvVar: string | undefined;

  if (yes) {
    // Non-interactive: only allow env-backed secret (no --api-key flag)
    const envName = flags.values.get("api-key-env") || flags.values.get("env");
    if (!envName) {
      throw new Error(
        "error: with --yes, pass --api-key-env ENV_VAR (plaintext --api-key is forbidden)"
      );
    }
    const v = process.env[envName];
    if (!v) throw new Error(`Environment variable ${envName} is not set.`);
    // Prefer storing as environment auth so vault is not a snapshot
    authMode = "environment";
    credentialEnvVar = envName;
  } else {
    if (preset.credentialEnvVar) {
      output.write(`  (suggested env: $${preset.credentialEnvVar})\n`);
    }
    const secret = await promptSecretIndirection("API key");
    if (secret.mode === "empty" || !secret.value) {
      throw new Error("API key cannot be empty.");
    }
    if (secret.mode === "env" && secret.envVar) {
      authMode = "environment";
      credentialEnvVar = secret.envVar;
    } else {
      apiKey = secret.value;
    }
  }

  // Azure / template base URLs may need user input
  let baseUrl = preset.defaultBaseUrl ?? "";
  if (!baseUrl || baseUrl.includes("{")) {
    if (yes) {
      baseUrl = flags.values.get("base-url") || baseUrl;
      if (!baseUrl || baseUrl.includes("{")) {
        throw new Error("error: this preset needs --base-url (template or empty default)");
      }
    } else {
      const def = baseUrl.includes("{") ? "" : baseUrl;
      baseUrl = await promptLine("Base URL", def || undefined);
      if (!baseUrl) throw new Error("Base URL cannot be empty.");
    }
  }

  output.write("Validating / saving…\n");
  const created = await apiJson<ProviderRow>("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      name: preset.name,
      adapter: preset.adapter,
      providerType: preset.providerType,
      baseUrl: baseUrl || preset.defaultBaseUrl,
      apiProtocol: preset.apiProtocol,
      authMode,
      apiKey,
      credentialEnvVar,
      discoverModels: true,
      defaultModelId: preset.defaultModelId || "default"
    })
  });

  if (created.credentialConfigured || authMode === "environment") {
    output.write(`[provider] Stored API key for built-in provider '${preset.id}'.\n`);
  }
  if (created.lastTestMessage) {
    output.write(`[provider] ${redactSecrets(created.lastTestMessage)}\n`);
    if (/网络失败|unreachable|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(created.lastTestMessage)) {
      output.write(
        `[provider] Tip: provider is saved; fix Base URL / network / key, then run: pawb provider test ${created.id}\n`
      );
    }
  }
  output.write(`[provider] Synced to Agent Service / PWA (id=${created.id}).\n`);
  return 0;
}

/** todos addCustomProvider — name, baseUrl, optional key, models */
async function addCustomStyleProvider(
  preset: CatalogPreset,
  flags: ParsedFlags,
  yes: boolean
): Promise<number> {
  const isOllama = preset.id === "ollama" || preset.adapter === "ollama";
  const needsKey = preset.requiresCredential !== false && !isOllama && preset.authModes.includes("api-key");

  let name =
    flags.values.get("name") ??
    (yes ? preset.id : await promptProviderName(preset.id));

  const apiProtocol =
    flags.values.get("api") ??
    flags.values.get("protocol") ??
    (preset.apiProtocol || "openai-completions");

  let baseUrl =
    flags.values.get("base-url") ??
    flags.values.get("baseUrl") ??
    preset.defaultBaseUrl ??
    "";

  if (!baseUrl) {
    if (yes) throw new Error("error: missing --base-url");
    baseUrl = await promptLine("Base URL");
  }
  if (!baseUrl) throw new Error("Base URL cannot be empty.");

  let apiKey: string | undefined;
  let authMode = isOllama ? "none" : "api-key";
  let credentialEnvVar: string | undefined;
  let allowDeferred = false;

  if (needsKey || (!isOllama && preset.allowDeferredCredential)) {
    if (yes) {
      const envName = flags.values.get("api-key-env") || flags.values.get("env");
      if (envName) {
        if (!process.env[envName]) throw new Error(`Environment variable ${envName} is not set.`);
        authMode = "environment";
        credentialEnvVar = envName;
      } else if (preset.allowDeferredCredential || !needsKey) {
        allowDeferred = true;
        authMode = "api-key";
      } else {
        throw new Error("error: with --yes, pass --api-key-env ENV_VAR or use a deferred-credential preset");
      }
    } else {
      const secret = await promptSecretIndirection("API key (empty to skip and configure later)", {
        allowEmpty: true
      });
      if (secret.mode === "empty") {
        allowDeferred = true;
        authMode = "api-key";
        output.write("[provider] API key skipped — configure later with `pawb provider login`.\n");
      } else if (secret.mode === "env" && secret.envVar) {
        authMode = "environment";
        credentialEnvVar = secret.envVar;
      } else {
        apiKey = secret.value;
        authMode = "api-key";
      }
    }
  } else if (isOllama) {
    authMode = "none";
  }

  // Models — todos: collect ids first, then per-id metadata
  const modelFlag = flags.repeated.get("model") ?? [];
  let models: ModelDraft[] = [];
  if (modelFlag.length > 0) {
    models = await collectModelDefsFromIds(modelFlag, yes);
  } else if (yes) {
    throw new Error("error: at least one --model is required with --yes");
  } else {
    models = await collectModelDefsInteractive();
  }
  if (models.length === 0) throw new Error("At least one model is required.");

  output.write("Validating / saving…\n");
  const created = await apiJson<ProviderRow>("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      name,
      adapter: preset.adapter,
      providerType: preset.providerType,
      baseUrl,
      apiProtocol,
      authMode,
      apiKey,
      credentialEnvVar,
      defaultModelId: models[0]?.remoteModelId,
      discoverModels: false,
      allowDeferredCredential: allowDeferred || preset.allowDeferredCredential,
      models: models.map((m) => ({
        remoteModelId: m.remoteModelId,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        supportsReasoning: m.supportsReasoning
      }))
    })
  });

  const n = models.length;
  output.write(
    `[provider] Provider '${created.name}' added with ${n} model${n === 1 ? "" : "s"}.\n`
  );
  if (created.credentialConfigured) {
    output.write(`[provider] Stored API key for provider '${created.name}'.\n`);
  }
  if (created.lastTestMessage) {
    output.write(`[provider] ${redactSecrets(created.lastTestMessage)}\n`);
    if (/网络失败|unreachable|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(created.lastTestMessage)) {
      output.write(
        `[provider] Tip: provider is saved; fix Base URL / network / key, then run: pawb provider test ${created.id}\n`
      );
    }
  }
  output.write(`[provider] Synced to Agent Service / PWA (id=${created.id}).\n`);
  return 0;
}

/** Ask for a stable identifier; reject accidental menu numbers like "1". */
async function promptProviderName(defaultId: string): Promise<string> {
  for (;;) {
    const name =
      (await promptLine("Provider name (e.g. my-gateway)", defaultId)).trim() || defaultId;
    if (/^\d{1,2}$/.test(name)) {
      output.write(
        "  That looks like a menu number, not a provider name. Try something like 'my-gateway'.\n"
      );
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      output.write(
        "  Use letters/digits/._- only (max 64 chars), starting with a letter or digit.\n"
      );
      continue;
    }
    return name;
  }
}

/** todos resolveAuthMethod — oauth | api-key only for multi-auth presets */
async function resolveAuthMethod(
  preset: CatalogPreset,
  flags: ParsedFlags,
  yes: boolean
): Promise<string> {
  // Only offer oauth when pi-ai actually supports the subscription login
  const methods = (preset.authModes ?? ["api-key"]).filter((m) => {
    if (m === "api-key") return true;
    if (m === "oauth") {
      const id = resolveOAuthProviderId(preset.id);
      return Boolean(id && isCliOAuthSupported(id));
    }
    return false;
  });
  const usable = methods.length > 0 ? methods : ["api-key"];

  const flag = flags.values.get("auth");
  if (flag !== undefined) {
    if (flag !== "oauth" && flag !== "api-key") {
      throw new Error(`Invalid --auth '${flag}' (expected oauth or api-key).`);
    }
    if (!usable.includes(flag)) {
      throw new Error(`'${preset.id}' does not support --auth ${flag}.`);
    }
    return flag;
  }
  if (usable.length === 1) return usable[0]!;
  if (yes) return "api-key";

  const choices = usable.map((m) =>
    m === "oauth"
      ? { id: "oauth", label: "Subscription (OAuth)" }
      : { id: "api-key", label: "API key" }
  );
  return promptSelect("How do you want to authenticate?", choices);
}

/** todos collectModelIdsInteractive + per-id context/max/reasoning */
async function collectModelDefsInteractive(): Promise<ModelDraft[]> {
  output.write("Add at least one model. Empty input finishes.\n");
  const ids: string[] = [];
  for (;;) {
    const id = await promptLine("  Model id");
    if (!id) {
      if (ids.length === 0) {
        output.write("  At least one model is required.\n");
        continue;
      }
      break;
    }
    ids.push(id);
  }
  return collectModelDefsFromIds(ids, false);
}

async function collectModelDefsFromIds(ids: string[], yes: boolean): Promise<ModelDraft[]> {
  const models: ModelDraft[] = [];
  for (const id of ids) {
    if (yes) {
      models.push({
        remoteModelId: id,
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsReasoning: false
      });
      continue;
    }
    const ctxRaw = await promptLine(`  '${id}' context window`, "128000");
    const maxRaw = await promptLine(`  '${id}' max tokens`, "16384");
    const reasoning = await promptConfirm(`  '${id}' supports reasoning?`, false);
    models.push({
      remoteModelId: id,
      contextWindow: Number(ctxRaw) || 128000,
      maxOutputTokens: Number(maxRaw) || 16384,
      supportsReasoning: reasoning
    });
  }
  return models;
}

async function testProvider(id?: string): Promise<number> {
  const providerId = id?.trim() || (await pickProviderId("Test which provider?"));
  const result = await apiJson<TestResult>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST",
    body: "{}"
  });
  output.write(`[provider] status=${result.status}\n`);
  output.write(`[provider] ${redactSecrets(result.message)}\n`);
  if (result.modelCount !== undefined) output.write(`[provider] models=${result.modelCount}\n`);
  return result.status === "ready" ? 0 : 1;
}

async function removeProvider(id: string | undefined, args: string[]): Promise<number> {
  const yes = args.includes("-y") || args.includes("--yes");
  const providerId = id?.trim() || (await pickProviderId("Remove which provider?"));
  if (!yes) {
    const ok = await promptConfirm(`Remove provider '${providerId}'?`, false);
    if (!ok) {
      output.write("Cancelled.\n");
      return 0;
    }
  }
  await apiVoid(`/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  output.write(`[provider] Removed '${providerId}'.\n`);
  return 0;
}

async function loginProvider(id?: string): Promise<number> {
  const providerId = id?.trim() || (await pickProviderId("Login which provider?"));

  // Prefer provider row metadata for oauth capability
  let row: ProviderRow | undefined;
  try {
    row = await apiJson<ProviderRow>(`/api/providers/${encodeURIComponent(providerId)}`);
  } catch {
    /* list-only path */
  }

  const oauthGuess =
    resolveOAuthProviderId(row?.name ?? "") ||
    resolveOAuthProviderId(providerId) ||
    (row?.name ? resolveOAuthProviderId(row.name) : undefined);

  const authChoices = [
    { id: "api-key", label: "API key" },
    ...(oauthGuess || listCliOAuthProviders().length
      ? [{ id: "oauth", label: "Subscription (OAuth)" }]
      : [])
  ];
  const mode = await promptSelect("How do you want to authenticate?", authChoices);

  if (mode === "oauth") {
    let oauthTarget = oauthGuess;
    if (!oauthTarget || !isCliOAuthSupported(oauthTarget)) {
      oauthTarget = await promptSearchSelect(
        "Which subscription OAuth provider?",
        listCliOAuthProviders().map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.id
        }))
      );
    }
    const { oauthProviderId, credentials } = await runInteractiveOAuthLogin(oauthTarget);
    const done = await apiJson<{
      id: string;
      name: string;
      status: string;
      lastTestMessage?: string;
    }>(`/api/providers/${encodeURIComponent(providerId)}/oauth/complete`, {
      method: "POST",
      body: JSON.stringify({ oauthProviderId, credentials })
    });
    output.write(`[provider] OAuth credentials stored for '${done.name}'.\n`);
    if (done.lastTestMessage) {
      output.write(`[provider] ${redactSecrets(done.lastTestMessage)}\n`);
    }
    return 0;
  }

  const secret = await promptSecretIndirection("API key");
  if (secret.mode === "env" && secret.envVar) {
    await apiJson(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ authMode: "environment", credentialEnvVar: secret.envVar })
    });
  } else {
    await apiJson(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "POST",
      body: JSON.stringify({ apiKey: secret.value })
    });
  }
  output.write(`[provider] Stored API key for provider '${providerId}'.\n`);
  const result = await apiJson<TestResult>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST",
    body: "{}"
  });
  output.write(`[provider] ${result.status}: ${redactSecrets(result.message)}\n`);
  return 0;
}

async function logoutProvider(id?: string): Promise<number> {
  const providerId = id?.trim() || (await pickProviderId("Logout which provider?"));
  await apiJson(`/api/providers/${encodeURIComponent(providerId)}/logout`, {
    method: "POST",
    body: "{}"
  });
  output.write(
    `[provider] Cleared credentials for '${providerId}'. Metadata kept — run login to re-auth.\n`
  );
  return 0;
}

async function pickProviderId(prompt = "Select provider"): Promise<string> {
  const list = await apiJson<ProviderRow[]>("/api/providers?detailed=1");
  if (list.length === 0) {
    output.write("No configured providers to select.\n");
    throw new Error("No configured providers. Run: pawb provider add");
  }
  return promptSearchSelect(
    prompt,
    list.map((p) => ({
      id: p.id,
      label: `${p.name} (${p.providerType ?? "custom"})`,
      hint: `${p.status}${p.baseUrl ? ` · ${p.baseUrl}` : ""}`
    }))
  );
}

// --- flag parser (minimal, mirrors todos parseFlags for our needs) ---

interface ParsedFlags {
  values: Map<string, string>;
  bools: Set<string>;
  repeated: Map<string, string[]>;
  positionals: string[];
}

function parseSimpleFlags(args: string[]): ParsedFlags {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const repeated = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        if (key === "model") {
          const list = repeated.get("model") ?? [];
          list.push(val);
          repeated.set("model", list);
        } else {
          values.set(key, val);
        }
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        if (key === "model") {
          const list = repeated.get("model") ?? [];
          list.push(next);
          repeated.set("model", list);
        } else if (key === "yes" || key === "json") {
          bools.add(key);
          continue;
        } else {
          values.set(key, next);
        }
        i++;
      } else {
        bools.add(key);
      }
      continue;
    }
    if (a === "-y") {
      bools.add("yes");
      continue;
    }
    if (a === "-j") {
      bools.add("json");
      continue;
    }
    positionals.push(a);
  }
  return { values, bools, repeated, positionals };
}
