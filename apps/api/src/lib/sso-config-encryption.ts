import { Result } from "better-result";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENCRYPTED_PREFIX = "sso:v1:encrypted";
const PLAINTEXT_PREFIX = "sso:v1:plaintext";
const KEY_INFO = Buffer.from("stella-sso-provider-config-v1", "utf-8");
const AAD = Buffer.from("stella:sso-provider-config:v1", "utf-8");
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/iu;

const getEncryptionKey = (): Buffer | null => {
  const configuredKey = process.env["CONTENT_ENCRYPTION_KEY"];
  if (!configuredKey) {
    return null;
  }
  if (!HEX_KEY_PATTERN.test(configuredKey)) {
    throw new ConfigurationError({
      message: "CONTENT_ENCRYPTION_KEY must be a 64-character hex string",
    });
  }

  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(configuredKey, "hex"),
      Buffer.alloc(0),
      KEY_INFO,
      KEY_BYTES,
    ),
  );
};

/**
 * Encrypt a Better Auth SSO configuration before Drizzle gives it to the
 * database driver. The plugin requires the configuration as one JSON string,
 * so this column-level envelope keeps its adapter contract while ensuring the
 * database never receives provider configuration, including OIDC client
 * secrets, in clear.
 */
export const encryptSsoConfigForStorage = (plaintext: string): string => {
  const key = getEncryptionKey();
  if (!key) {
    return `${PLAINTEXT_PREFIX}:${Buffer.from(plaintext, "utf-8").toString("base64url")}`;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_PREFIX,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
};

export const decryptSsoConfigFromStorage = (stored: string): string => {
  const plaintextPrefix = `${PLAINTEXT_PREFIX}:`;
  if (stored.startsWith(plaintextPrefix)) {
    if (getEncryptionKey()) {
      throw new ConfigurationError({
        message:
          "Stored SSO configuration is plaintext while encryption is configured",
      });
    }
    return Buffer.from(
      stored.slice(plaintextPrefix.length),
      "base64url",
    ).toString("utf-8");
  }

  const [scope, version, mode, ivPart, ciphertextPart, authTagPart, ...rest] =
    stored.split(":");
  if (
    scope !== "sso" ||
    version !== "v1" ||
    mode !== "encrypted" ||
    !ivPart ||
    !ciphertextPart ||
    !authTagPart ||
    rest.length > 0
  ) {
    throw new ConfigurationError({
      message: "Stored SSO configuration has an invalid encryption envelope",
    });
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new ConfigurationError({
      message:
        "SSO configuration is encrypted but CONTENT_ENCRYPTION_KEY is not set",
    });
  }

  const decrypted = Result.try({
    try: () => {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivPart, "base64url"),
        { authTagLength: AUTH_TAG_BYTES },
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, "base64url")),
        decipher.final(),
      ]).toString("utf-8");
    },
    catch: (cause) =>
      new ConfigurationError({
        message: "Stored SSO configuration could not be decrypted",
        cause,
      }),
  });
  if (Result.isError(decrypted)) {
    throw decrypted.error;
  }
  return decrypted.value;
};
