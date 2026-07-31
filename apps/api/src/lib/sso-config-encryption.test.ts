import { describe, expect, test } from "bun:test";

import {
  decryptSsoConfigFromStorage,
  encryptSsoConfigForStorage,
} from "@/api/lib/sso-config-encryption";

const CONTENT_ENCRYPTION_KEY = "CONTENT_ENCRYPTION_KEY";
const TEST_ENCRYPTION_KEY = "00".repeat(32);

const withContentEncryptionKey = <T>(
  key: string | undefined,
  run: () => T,
): T => {
  const previous = process.env[CONTENT_ENCRYPTION_KEY];
  if (key === undefined) {
    Reflect.deleteProperty(process.env, CONTENT_ENCRYPTION_KEY);
  } else {
    process.env[CONTENT_ENCRYPTION_KEY] = key;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, CONTENT_ENCRYPTION_KEY);
    } else {
      process.env[CONTENT_ENCRYPTION_KEY] = previous;
    }
  }
};

describe("SSO provider configuration storage", () => {
  test("round-trips without placing the secret in the stored envelope", () => {
    withContentEncryptionKey(TEST_ENCRYPTION_KEY, () => {
      const config = '{"clientSecret":"secret-that-must-not-leak"}';
      const stored = encryptSsoConfigForStorage(config);

      expect(stored).toStartWith("sso:v1:encrypted:");
      expect(stored).not.toContain("secret-that-must-not-leak");
      expect(decryptSsoConfigFromStorage(stored)).toBe(config);
    });
  });

  test("rejects an unknown envelope instead of treating it as plaintext", () => {
    withContentEncryptionKey(undefined, () => {
      expect(() =>
        decryptSsoConfigFromStorage('{"clientSecret":"raw"}'),
      ).toThrow("invalid encryption envelope");
    });
  });

  test("rejects a plaintext downgrade when encryption is configured", () => {
    const stored = withContentEncryptionKey(undefined, () =>
      encryptSsoConfigForStorage("secret"),
    );

    withContentEncryptionKey(TEST_ENCRYPTION_KEY, () => {
      expect(() => decryptSsoConfigFromStorage(stored)).toThrow(
        "plaintext while encryption is configured",
      );
    });
  });
});
