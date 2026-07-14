/**
 * Bundle / update integrity + signature verification.
 *
 * - SHA-256 content hash (always required)
 * - Ed25519 signatures over raw bytes (preferred, Node crypto)
 * - HMAC-SHA256 fallback when `hmacSecret` is configured (tests / air-gapped)
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject
} from "node:crypto";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeHexHash(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

export function assertSha256Match(data: Buffer | string, expectedHex: string, context = "payload"): void {
  const actual = sha256Hex(data);
  const expected = normalizeHexHash(expectedHex);
  if (actual !== expected) {
    throw new Error(`${context} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

export type SignatureAlgorithm = "ed25519" | "hmac-sha256";

export interface VerifySignatureOptions {
  algorithm?: SignatureAlgorithm;
  /** PEM or raw base64 SPKI for Ed25519 public key. */
  publicKeyPem?: string;
  /** Shared secret for HMAC mode. */
  hmacSecret?: string;
}

export function signEd25519(data: Buffer | string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), key);
  return signature.toString("base64");
}

export function verifyEd25519(data: Buffer | string, signatureBase64: string, publicKeyPem: string): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new Error(`invalid ed25519 public key: ${error instanceof Error ? error.message : String(error)}`);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  try {
    return cryptoVerify(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function signHmacSha256(data: Buffer | string, secret: string): string {
  return createHmac("sha256", secret)
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"))
    .digest("base64");
}

export function verifyHmacSha256(data: Buffer | string, signatureBase64: string, secret: string): boolean {
  const expected = signHmacSha256(data, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureBase64.trim(), "utf8");
  if (a.length !== b.length) return false;
  // constant-time-ish compare
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i]! ^ b[i]!;
  }
  return mismatch === 0;
}

export function verifySignature(
  data: Buffer | string,
  signatureBase64: string,
  options: VerifySignatureOptions
): void {
  const algorithm = options.algorithm ?? (options.hmacSecret ? "hmac-sha256" : "ed25519");
  if (algorithm === "hmac-sha256") {
    if (!options.hmacSecret) {
      throw new Error("hmac-sha256 verification requires hmacSecret");
    }
    if (!verifyHmacSha256(data, signatureBase64, options.hmacSecret)) {
      throw new Error("signature verification failed (hmac-sha256)");
    }
    return;
  }
  if (!options.publicKeyPem) {
    throw new Error("ed25519 verification requires publicKeyPem");
  }
  if (!verifyEd25519(data, signatureBase64, options.publicKeyPem)) {
    throw new Error("signature verification failed (ed25519)");
  }
}

/**
 * Canonical JSON for unsigned update manifest fields (stable key order).
 * Must match what was signed by the publisher.
 */
export function serializeUnsignedUpdateManifest(fields: {
  channel: string;
  platform: string;
  arch: string;
  latestVersion: string;
  minimumLauncherVersion: string;
  bundleUrl: string;
  bundleSha256: string;
  bundleSignature: string;
  releaseNotesUrl: string | null;
  migrationVersion?: number;
}): string {
  const body: Record<string, unknown> = {
    arch: fields.arch,
    bundleSha256: normalizeHexHash(fields.bundleSha256),
    bundleSignature: fields.bundleSignature,
    bundleUrl: fields.bundleUrl,
    channel: fields.channel,
    latestVersion: fields.latestVersion,
    minimumLauncherVersion: fields.minimumLauncherVersion,
    platform: fields.platform,
    releaseNotesUrl: fields.releaseNotesUrl
  };
  if (typeof fields.migrationVersion === "number") {
    body.migrationVersion = fields.migrationVersion;
  }
  return JSON.stringify(body);
}
