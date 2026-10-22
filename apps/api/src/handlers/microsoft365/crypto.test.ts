import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  MICROSOFT365_TOKEN_PURPOSE,
  decryptMicrosoft365Secret,
  encryptMicrosoft365Secret,
} from "@/api/handlers/microsoft365/crypto";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const organizationId = toSafeId<"organization">(
  "0191d14d-9a63-7d2e-a021-06053e542c85",
);
const userId = toSafeId<"user">("0191d14d-9a63-7d2e-a021-06053e542c87");
const secret = "graph-access-token-value";

describe("encryptMicrosoft365Secret / decryptMicrosoft365Secret", () => {
  test("roundtrips on an exact purpose/user match", async () => {
    const { ciphertext, iv } = await encryptMicrosoft365Secret({
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      secret,
      userId,
    });

    const decrypted = await decryptMicrosoft365Secret({
      ciphertext,
      iv,
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      userId,
    });

    expect(String(decrypted.unwrap())).toBe(secret);
  });

  test("roundtrips arbitrary payloads (invariant over the value space)", async () => {
    const payloads = Array.from({ length: 32 }, () => {
      const length = Math.floor(Math.random() * 256);
      return Array.from({ length }, () =>
        String.fromCodePoint(33 + Math.floor(Math.random() * 94)),
      ).join("");
    });

    for (const payload of payloads) {
      const { ciphertext, iv } = await encryptMicrosoft365Secret({
        organizationId,
        purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
        secret: payload,
        userId,
      });
      const decrypted = await decryptMicrosoft365Secret({
        ciphertext,
        iv,
        organizationId,
        purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
        userId,
      });
      expect(String(decrypted.unwrap())).toBe(payload);
    }
  });

  test("rejects a purpose mismatch (access token read back as refresh)", async () => {
    const { ciphertext, iv } = await encryptMicrosoft365Secret({
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      secret,
      userId,
    });

    const decrypt = await decryptMicrosoft365Secret({
      ciphertext,
      iv,
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
      userId,
    });

    expect(Result.isError(decrypt)).toBe(true);
    if (Result.isError(decrypt)) {
      expect(decrypt.error).toBeInstanceOf(HandlerError);
    }
  });

  test("rejects a userId mismatch", async () => {
    const { ciphertext, iv } = await encryptMicrosoft365Secret({
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      secret,
      userId,
    });

    const decrypt = await decryptMicrosoft365Secret({
      ciphertext,
      iv,
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      userId: toSafeId<"user">("0191d14d-9a63-7d2e-a021-06053e542c99"),
    });

    expect(Result.isError(decrypt)).toBe(true);
    if (Result.isError(decrypt)) {
      expect(decrypt.error).toBeInstanceOf(HandlerError);
    }
  });

  test("stores ciphertext rather than the plaintext envelope", async () => {
    const { ciphertext, iv } = await encryptMicrosoft365Secret({
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      secret,
      userId,
    });

    expect(ciphertext.toString("utf-8")).not.toContain(secret);
    expect(ciphertext.toString("utf-8")).not.toContain(
      MICROSOFT365_TOKEN_PURPOSE.access,
    );
    // A zero IV is the no-op plaintext envelope; real AES-GCM never mints one.
    expect(iv.every((byte) => byte === 0)).toBe(false);
  });

  test("rejects an organization mismatch (per-org key separation)", async () => {
    const { ciphertext, iv } = await encryptMicrosoft365Secret({
      organizationId,
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      secret,
      userId,
    });

    const decrypt = await decryptMicrosoft365Secret({
      ciphertext,
      iv,
      organizationId: toSafeId<"organization">(
        "0191d14d-9a63-7d2e-a021-06053e542c9a",
      ),
      purpose: MICROSOFT365_TOKEN_PURPOSE.access,
      userId,
    });

    expect(Result.isError(decrypt)).toBe(true);
    if (Result.isError(decrypt)) {
      expect(decrypt.error).toBeInstanceOf(HandlerError);
    }
  });
});

test("existing delegated token envelopes remain readable with their original purposes", async () => {
  for (const [storedPurpose, purpose] of [
    ["sharepoint_access_token", MICROSOFT365_TOKEN_PURPOSE.access],
    ["sharepoint_refresh_token", MICROSOFT365_TOKEN_PURPOSE.refresh],
  ] as const) {
    const encrypted = await encryptContent(
      organizationId,
      JSON.stringify({ purpose: storedPurpose, secret, userId }),
    );
    const decrypted = await decryptMicrosoft365Secret({
      ...encrypted,
      organizationId,
      purpose,
      userId,
    });
    expect(String(decrypted.unwrap())).toBe(secret);
  }
});

test("delegated token ciphertext purposes remain the complete frozen storage contract", () => {
  expect(MICROSOFT365_TOKEN_PURPOSE).toEqual({
    access: "sharepoint_access_token",
    refresh: "sharepoint_refresh_token",
  });
});
