/**
 * Per-organization AES-256-GCM encryption for extracted
 * file content. Defense-in-depth: even if the DB is
 * compromised, extracted text stays encrypted.
 *
 * When CONTENT_ENCRYPTION_KEY is absent (dev mode), content
 * is stored as plaintext wrapped in a no-op envelope so the
 * schema stays consistent.
 */

import { hkdf } from "node:crypto";

import { env } from "@/api/env";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = "AES-GCM";

const getMasterKey = (): Buffer | null => {
  const hex = env.CONTENT_ENCRYPTION_KEY;
  if (!hex) {
    return null;
  }
  return Buffer.from(hex, "hex");
};

/**
 * Derive a 256-bit per-org key using HKDF-SHA256.
 * The org ID is used as the `info` parameter so each
 * organization gets an independent key.
 */
const deriveOrgKey = async (
  masterKey: Buffer,
  organizationId: string,
): Promise<Buffer> =>
  await new Promise((resolve, reject) => {
    hkdf(
      "sha256",
      masterKey,
      Buffer.alloc(0),
      organizationId,
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
 * Encrypt plaintext with AES-256-GCM using an org-derived
 * key. When the master key is absent, wraps plaintext in a
 * no-op envelope (iv = 12 zero bytes, ciphertext = UTF-8).
 */
export const encryptContent = async (
  organizationId: string,
  plaintext: string,
): Promise<EncryptedContent> => {
  const masterKey = getMasterKey();

  if (!masterKey) {
    return {
      ciphertext: Buffer.from(plaintext, "utf-8"),
      iv: Buffer.alloc(IV_BYTES),
    };
  }

  const orgKey = await deriveOrgKey(masterKey, organizationId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const keyBytes = new Uint8Array(orgKey);

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
export const decryptContent = async (
  organizationId: string,
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

  const orgKey = await deriveOrgKey(masterKey, organizationId);
  const keyBytes = new Uint8Array(orgKey);

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
