/**
 * Secrets sealed into single text columns with the content encryption key.
 * Synchronous, so a Drizzle column type can apply it on every read and
 * write. Schema modules import it, so it stays apart from
 * `content-encryption.ts` and out of the base environment's module graph.
 */
import { Result } from "better-result";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { getContentEncryptionMasterKey as getMasterKey } from "@/api/env-content-encryption";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { recordReadWork } from "@/api/lib/observability/request-work";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * A secret stored in one text column. Each scope names the table and column
 * it seals and derives its own key, never shared with the content encryption
 * scopes. Text sealed under one scope opens under no other, but nothing
 * binds it to its row: any role that can write the row can already change
 * every other column the secret configures.
 */
export type SealedTextScope = `stella:sealed-text:v1:${string}`;

const SEALED_TEXT_VERSION = "v1";
const SEALED_TEXT_KEY_ID_BYTES = 6;

type SealedTextKey = { key: Buffer; keyId: string };

const sealedTextKeys = new Map<string, SealedTextKey>();

const sealedTextKey = (
  scope: SealedTextScope,
): Result<SealedTextKey, ConfigurationError> => {
  const masterKey = getMasterKey();
  if (!masterKey) {
    return Result.err(
      new ConfigurationError({
        message: "Sealed secret storage requires CONTENT_ENCRYPTION_KEY",
      }),
    );
  }
  // Keyed by the master key too, so a test that swaps the key never reads a
  // key derived from the previous one.
  const cacheKey = `${masterKey.toString("hex")}\u0000${scope}`;
  const cached = sealedTextKeys.get(cacheKey);
  if (cached) {
    return Result.ok(cached);
  }
  const key = Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), scope, AES_KEY_BYTES),
  );
  // Names the key in the envelope so a later rotation can tell which key
  // sealed a value; a truncated keyed hash reveals nothing about the key.
  const keyId = new Bun.CryptoHasher("sha256", key)
    .update("key-id")
    .digest()
    .subarray(0, SEALED_TEXT_KEY_ID_BYTES)
    .toBase64({ alphabet: "base64url", omitPadding: true });
  const derived = { key, keyId };
  sealedTextKeys.set(cacheKey, derived);
  return Result.ok(derived);
};

const sealedEnvelopeError = () =>
  new ConfigurationError({ message: "Sealed secret has no valid envelope" });

/**
 * Seal `plaintext` as `v1.<key id>.<iv>.<ciphertext and tag>` (base64url
 * parts), AES-256-GCM with the scope as additional data. Requires the
 * content key in every runtime mode: there is no plaintext fallback.
 */
export const sealText = (
  scope: SealedTextScope,
  plaintext: string,
): Result<string, ConfigurationError> =>
  sealedTextKey(scope).map(({ key, keyId }) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(scope, "utf-8"));
    const sealed = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [
      SEALED_TEXT_VERSION,
      keyId,
      iv.toBase64({ alphabet: "base64url", omitPadding: true }),
      sealed.toBase64({ alphabet: "base64url", omitPadding: true }),
    ].join(".");
  });

/** Open text {@link sealText} sealed under the same scope and key. */
export const openText = (
  scope: SealedTextScope,
  sealed: string,
): Result<string, ConfigurationError> => {
  const derived = sealedTextKey(scope);
  if (Result.isError(derived)) {
    return Result.err(derived.error);
  }
  const { key, keyId } = derived.value;
  const parts = sealed.split(".");
  const [version, sealedKeyId, ivPart, payloadPart] = parts;
  if (
    parts.length !== 4 ||
    version !== SEALED_TEXT_VERSION ||
    ivPart === undefined ||
    payloadPart === undefined
  ) {
    return Result.err(sealedEnvelopeError());
  }
  if (sealedKeyId !== keyId) {
    return Result.err(
      new ConfigurationError({
        message: "Sealed secret was sealed under another key",
      }),
    );
  }
  const iv = Buffer.from(ivPart, "base64url");
  const payload = Buffer.from(payloadPart, "base64url");
  if (iv.length !== IV_BYTES || payload.length < AUTH_TAG_BYTES) {
    return Result.err(sealedEnvelopeError());
  }
  const tagStart = payload.length - AUTH_TAG_BYTES;
  return Result.try({
    try: () => {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(scope, "utf-8"));
      decipher.setAuthTag(payload.subarray(tagStart));
      const opened = Buffer.concat([
        decipher.update(payload.subarray(0, tagStart)),
        decipher.final(),
      ]);
      recordReadWork("decryptedBytes", opened.byteLength);
      return opened.toString("utf-8");
    },
    catch: () =>
      new ConfigurationError({ message: "Sealed secret could not be opened" }),
  });
};
