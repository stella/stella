/**
 * Per-organization AES-256-GCM encryption for extracted
 * file content. Defense-in-depth: even if the DB is
 * compromised, extracted text stays encrypted.
 *
 * When CONTENT_ENCRYPTION_KEY is absent, content is stored
 * as plaintext wrapped in a no-op envelope so the schema
 * stays consistent. The worker env validator
 * (`apps/api/src/env-document-processing-worker.ts`)
 * requires the key unless local development access is open, so this
 * fallback only fires in local development and tests.
 */

import { Result } from "better-result";
import { createHmac, hkdf } from "node:crypto";

import { sha256Hex } from "@stll/sha256/bun";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { SafeId } from "@/api/lib/branded-types";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = "AES-GCM";

const getMasterKey = (): Buffer | null => {
  const hex = envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY;
  if (!hex) {
    return null;
  }
  return Buffer.from(hex, "hex");
};

/**
 * Derive a 256-bit key using HKDF-SHA256. The scope is the
 * `info` parameter; organization IDs and application content use distinct scopes.
 */
const deriveScopeKey = async (
  masterKey: Buffer,
  scope: string,
): Promise<Buffer> =>
  await new Promise((resolve, reject) => {
    hkdf(
      "sha256",
      masterKey,
      Buffer.alloc(0),
      scope,
      AES_KEY_BYTES,
      (err, key) => {
        if (err) {
          reject(err);
        } else {
          resolve(Buffer.from(key));
        }
      },
    );
  });

export type EncryptedContent = {
  ciphertext: Buffer;
  iv: Buffer;
};

/**
 * Encrypt plaintext with AES-256-GCM using a scope-derived
 * key. When the master key is absent, wraps plaintext in a
 * no-op envelope (iv = 12 zero bytes, ciphertext = UTF-8).
 */
const encryptScopedContent = async (
  scope: string,
  plaintext: string,
): Promise<EncryptedContent> => {
  const masterKey = getMasterKey();

  if (!masterKey) {
    return {
      ciphertext: Buffer.from(plaintext, "utf-8"),
      iv: Buffer.alloc(IV_BYTES),
    };
  }

  const scopeKey = await deriveScopeKey(masterKey, scope);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const keyBytes = new Uint8Array(scopeKey);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    ALGORITHM,
    false,
    ["encrypt"],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: AUTH_TAG_BYTES * 8 },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: Buffer.from(encrypted),
    iv: Buffer.from(iv),
  };
};

/**
 * Decrypt AES-256-GCM ciphertext. When the master key is
 * absent, treats ciphertext as plaintext UTF-8.
 */
const decryptScopedContent = async (
  scope: string,
  ciphertext: Buffer,
  iv: Buffer,
): Promise<string> => {
  // All-zero IV means the content was stored as plaintext
  // (no-op envelope). Return UTF-8 regardless of whether
  // the master key is currently set, so plaintext rows
  // survive key rotation without silent data loss.
  const isPlaintext = iv.every((b) => b === 0);
  if (isPlaintext) {
    return ciphertext.toString("utf-8");
  }

  const masterKey = getMasterKey();

  if (!masterKey) {
    throw new ConfigurationError({
      message: "Content was encrypted but CONTENT_ENCRYPTION_KEY is not set",
    });
  }

  const scopeKey = await deriveScopeKey(masterKey, scope);
  const keyBytes = new Uint8Array(scopeKey);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    ALGORITHM,
    false,
    ["decrypt"],
  );

  const decrypted = await crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      iv: new Uint8Array(iv),
      tagLength: AUTH_TAG_BYTES * 8,
    },
    cryptoKey,
    new Uint8Array(ciphertext),
  );

  return new TextDecoder().decode(decrypted);
};

export const encryptContent = async (
  organizationId: SafeId<"organization">,
  plaintext: string,
): Promise<EncryptedContent> =>
  await encryptScopedContent(organizationId, plaintext);

export const decryptContent = async (
  organizationId: SafeId<"organization">,
  ciphertext: Buffer,
  iv: Buffer,
): Promise<string> =>
  await decryptScopedContent(organizationId, ciphertext, iv);

const LOOKUP_KEY_SCOPE = "stella:content-lookup:v1:";

/**
 * A stable keyed hash (HMAC-SHA256, hex) of `value` for finding an equal
 * encrypted value without decrypting: AES-GCM ciphertexts of one plaintext
 * differ, so equality is matched on this instead. The key is derived from
 * the content key per organization, so one firm's hashes match nothing in
 * another's. Without the content key (local development and tests, as for
 * the no-op envelope) it is an unkeyed SHA-256 of the same input.
 */
export const contentLookupKey = async (
  organizationId: SafeId<"organization">,
  value: string,
): Promise<string> => {
  const masterKey = getMasterKey();
  if (!masterKey) {
    return sha256Hex(`${organizationId}\u0000${value}`);
  }
  return keyedContentLookupKey(organizationId, value);
};

/** Keyed identifiers never fall back to a guessable plaintext digest. */
export const keyedContentLookupKey = async (
  organizationId: SafeId<"organization">,
  value: string,
): Promise<string> => {
  const masterKey = getMasterKey();
  if (!masterKey) {
    throw new ConfigurationError({
      message: "Keyed content identifiers require CONTENT_ENCRYPTION_KEY",
    });
  }
  const scopeKey = await deriveScopeKey(
    masterKey,
    `${LOOKUP_KEY_SCOPE}${organizationId}`,
  );
  return createHmac("sha256", scopeKey).update(value).digest("hex");
};

const APP_CONTENT_SCOPE = "stella:app-content:v1";

const requireAppContentKey = (): Result<void, ConfigurationError> =>
  getMasterKey()
    ? Result.ok(undefined)
    : Result.err(
        new ConfigurationError({
          message:
            "Application credential storage requires CONTENT_ENCRYPTION_KEY",
        }),
      );

export const encryptAppContent = async (
  plaintext: string,
): Promise<Result<EncryptedContent, ConfigurationError>> => {
  const configured = requireAppContentKey();
  if (Result.isError(configured)) {
    return Result.err(configured.error);
  }
  return await Result.tryPromise({
    try: async () => await encryptScopedContent(APP_CONTENT_SCOPE, plaintext),
    catch: () =>
      new ConfigurationError({
        message: "Could not prepare application content",
      }),
  });
};

export const decryptAppContent = async (
  ciphertext: Buffer,
  iv: Buffer,
): Promise<Result<string, ConfigurationError>> => {
  const configured = requireAppContentKey();
  if (Result.isError(configured)) {
    return Result.err(configured.error);
  }
  if (iv.length !== IV_BYTES || iv.every((byte) => byte === 0)) {
    return Result.err(
      new ConfigurationError({
        message: "Application credential storage requires the shared envelope",
      }),
    );
  }
  return await Result.tryPromise({
    try: async () =>
      await decryptScopedContent(APP_CONTENT_SCOPE, ciphertext, iv),
    catch: () =>
      new ConfigurationError({ message: "Could not read application content" }),
  });
};
