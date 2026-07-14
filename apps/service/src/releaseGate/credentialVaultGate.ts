/**
 * Credential vault + redaction release-gate contracts.
 * Ensures secrets stay in the vault, never in public API rows, connection index files, or logs.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionService,
  toPublicConnection,
  type CredentialVault
} from "../connections/connectionService.js";
import { redactJsonValue, redactSecrets } from "../model/redact.js";
import type { ReleaseGateCheck } from "./releaseGateTypes.js";

export class MemoryCredentialVault implements CredentialVault {
  readonly values = new Map<string, string>();

  async read(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }

  async write(reference: string, secret: string): Promise<void> {
    this.values.set(reference, secret);
  }

  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

export interface CredentialVaultGateOptions {
  /** Optional pre-built vault (tests). Default: in-memory. */
  vault?: MemoryCredentialVault;
  /** Optional working directory for connection index persistence. */
  workDir?: string;
  /** Secret sample used to assert redaction (must not appear in public surfaces). */
  sampleSecret?: string;
}

const DEFAULT_SECRET = "sk-gate-test-secret-value-NEVER-LOG";

/**
 * Verify credential vault redaction contracts without Windows Credential Manager:
 * - API key stored only in vault
 * - Public connection has no apiKey / credentialRef / raw secret
 * - Connection index JSON on disk has no raw secret
 * - Backup snapshot export never embeds the secret
 * - redactSecrets / redactJsonValue strip known secret shapes from log-like text
 */
export async function checkCredentialVaultRedaction(
  options: CredentialVaultGateOptions = {}
): Promise<ReleaseGateCheck> {
  const sampleSecret = options.sampleSecret ?? DEFAULT_SECRET;
  const ownDir = options.workDir === undefined;
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), "paw-release-gate-vault-")));
  const vault = options.vault ?? new MemoryCredentialVault();

  try {
    const statePath = join(workDir, "connections.json");
    const connections = await ConnectionService.open(statePath, vault);
    const created = await connections.create({
      name: "gate-proxy",
      baseUrl: "https://api.example.test/v1",
      apiKey: sampleSecret,
      modelId: "gpt-gate"
    });

    // Vault holds the secret under credentialRef.
    const internal = await connections.get(created.id);
    const vaultValue = await vault.read(internal.credentialRef);
    if (vaultValue !== sampleSecret) {
      return failCred("VAULT_WRITE_MISMATCH", "Credential vault did not retain the API key under credentialRef.", {
        credentialRef: internal.credentialRef
      });
    }

    // Public surface must never expose secrets or vault refs.
    const publicRow = toPublicConnection(internal);
    const publicJson = JSON.stringify(publicRow);
    if ("apiKey" in (publicRow as object) || publicJson.includes("apiKey")) {
      return failCred("PUBLIC_HAS_API_KEY", "Public connection must not include apiKey.", { publicRow });
    }
    if ("credentialRef" in (publicRow as object) || publicJson.includes("credentialRef")) {
      return failCred("PUBLIC_HAS_CREDENTIAL_REF", "Public connection must not include credentialRef.", {
        publicRow
      });
    }
    if (publicJson.includes(sampleSecret)) {
      return failCred("PUBLIC_LEAKS_SECRET", "Public connection JSON leaked the raw secret.", {});
    }
    if (publicRow.credentialPresent !== true) {
      return failCred("PUBLIC_CREDENTIAL_PRESENT_FLAG", "Public row should report credentialPresent=true without revealing the secret.", {
        publicRow
      });
    }

    const listed = await connections.listPublic();
    if (listed.some((row) => JSON.stringify(row).includes(sampleSecret))) {
      return failCred("LIST_PUBLIC_LEAKS_SECRET", "listPublic leaked the raw secret.", {});
    }

    // Durable index on disk must not store the API key value.
    const onDisk = await readFile(statePath, "utf8");
    if (onDisk.includes(sampleSecret)) {
      return failCred("INDEX_FILE_LEAKS_SECRET", "connections.json must not persist the raw API key.", {
        statePath
      });
    }
    if (/"apiKey"\s*:/.test(onDisk)) {
      return failCred("INDEX_FILE_HAS_API_KEY_FIELD", "connections.json must not contain an apiKey field.", {
        statePath
      });
    }

    // Backup snapshot never reads vault secrets.
    const snapshot = await connections.exportSnapshot();
    const snapshotJson = JSON.stringify(snapshot);
    if (snapshotJson.includes(sampleSecret)) {
      return failCred("BACKUP_SNAPSHOT_LEAKS_SECRET", "exportSnapshot must not embed vault secrets.", {});
    }
    if (snapshot.connections.some((row) => !row.credentialRef)) {
      return failCred("BACKUP_MISSING_CREDENTIAL_REF", "Backup rows should keep opaque credentialRef placeholders only.", {
        snapshot
      });
    }

    // Log / timeline redaction helpers.
    const leakyLog = [
      `Authorization: Bearer ${sampleSecret}`,
      `api_key=${sampleSecret}`,
      `Cookie: session=${sampleSecret}`,
      "normal operational message"
    ].join("\n");
    const redacted = redactSecrets(leakyLog);
    if (redacted.includes(sampleSecret)) {
      return failCred("REDACT_SECRETS_FAILED", "redactSecrets left the sample secret in log text.", {
        redacted
      });
    }
    if (!redacted.includes("normal operational message")) {
      return failCred("REDACT_SECRETS_OVERREACH", "redactSecrets removed non-secret operational text.", {
        redacted
      });
    }

    const redactedObj = redactJsonValue({
      message: "ok",
      apiKey: sampleSecret,
      nested: { token: sampleSecret, path: "src/main.ts" }
    });
    const redactedObjJson = JSON.stringify(redactedObj);
    if (redactedObjJson.includes(sampleSecret)) {
      return failCred("REDACT_JSON_FAILED", "redactJsonValue left the sample secret in JSON.", {
        redactedObj
      });
    }
    if ((redactedObj as { nested: { path: string } }).nested.path !== "src/main.ts") {
      return failCred("REDACT_JSON_OVERREACH", "redactJsonValue corrupted non-sensitive fields.", {
        redactedObj
      });
    }

    return {
      id: "credential-vault-redaction",
      name: "Credential vault redaction contracts",
      category: "credentials",
      status: "pass",
      code: "CREDENTIAL_VAULT_REDACTION_OK",
      detail:
        "API keys stay in the credential vault only; public rows, connection index, backup snapshot, and log redaction helpers never expose the secret.",
      meta: {
        connectionId: created.id,
        credentialRef: internal.credentialRef,
        credentialPresent: publicRow.credentialPresent,
        vaultBackend: "memory"
      }
    };
  } catch (error) {
    return failCred(
      "CREDENTIAL_VAULT_GATE_ERROR",
      error instanceof Error ? error.message : String(error),
      {}
    );
  } finally {
    if (ownDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function failCred(code: string, detail: string, meta: Record<string, unknown>): ReleaseGateCheck {
  return {
    id: "credential-vault-redaction",
    name: "Credential vault redaction contracts",
    category: "credentials",
    status: "fail",
    code,
    detail,
    remediation:
      "Ensure ConnectionService stores secrets only via CredentialVault, toPublicConnection strips secret fields, and model/redact helpers cover Authorization/apiKey shapes.",
    meta
  };
}
