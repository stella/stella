import { describe, expect, test } from "bun:test";

import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/handlers/sharepoint/crypto";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

const organizationId = toSafeId<"organization">(
  "0191d14d-9a63-7d2e-a021-06053e542c85",
);
const userId = toSafeId<"user">("0191d14d-9a63-7d2e-a021-06053e542c87");
const secret = "graph-access-token-value";

describe("encryptSharepointSecret / decryptSharepointSecret", () => {
  test("roundtrips on an exact purpose/user match", async () => {
    const { ciphertext, iv } = await encryptSharepointSecret({
      organizationId,
      purpose: "sharepoint_access_token",
      secret,
      userId,
    });

    const decrypted = await decryptSharepointSecret({
      ciphertext,
      iv,
      organizationId,
      purpose: "sharepoint_access_token",
      userId,
    });

    expect(String(decrypted)).toBe(secret);
  });

  test("roundtrips arbitrary payloads (invariant over the value space)", async () => {
    const payloads = Array.from({ length: 32 }, () => {
      const length = Math.floor(Math.random() * 256);
      return Array.from({ length }, () =>
        String.fromCodePoint(33 + Math.floor(Math.random() * 94)),
      ).join("");
    });

    for (const payload of payloads) {
      const { ciphertext, iv } = await encryptSharepointSecret({
        organizationId,
        purpose: "sharepoint_refresh_token",
        secret: payload,
        userId,
      });
      const decrypted = await decryptSharepointSecret({
        ciphertext,
        iv,
        organizationId,
        purpose: "sharepoint_refresh_token",
        userId,
      });
      expect(String(decrypted)).toBe(payload);
    }
  });

  test("rejects a purpose mismatch (access token read back as refresh)", async () => {
    const { ciphertext, iv } = await encryptSharepointSecret({
      organizationId,
      purpose: "sharepoint_access_token",
      secret,
      userId,
    });

    const decrypt = decryptSharepointSecret({
      ciphertext,
      iv,
      organizationId,
      purpose: "sharepoint_refresh_token",
      userId,
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  test("rejects a userId mismatch", async () => {
    const { ciphertext, iv } = await encryptSharepointSecret({
      organizationId,
      purpose: "sharepoint_access_token",
      secret,
      userId,
    });

    const decrypt = decryptSharepointSecret({
      ciphertext,
      iv,
      organizationId,
      purpose: "sharepoint_access_token",
      userId: toSafeId<"user">("0191d14d-9a63-7d2e-a021-06053e542c99"),
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  test("stores ciphertext rather than the plaintext envelope", async () => {
    const { ciphertext, iv } = await encryptSharepointSecret({
      organizationId,
      purpose: "sharepoint_access_token",
      secret,
      userId,
    });

    expect(ciphertext.toString("utf-8")).not.toContain(secret);
    expect(ciphertext.toString("utf-8")).not.toContain(
      "sharepoint_access_token",
    );
    // A zero IV is the no-op plaintext envelope; real AES-GCM never mints one.
    expect(iv.every((byte) => byte === 0)).toBe(false);
  });

  test("rejects an organization mismatch (per-org key separation)", async () => {
    const { ciphertext, iv } = await encryptSharepointSecret({
      organizationId,
      purpose: "sharepoint_access_token",
      secret,
      userId,
    });

    const decrypt = decryptSharepointSecret({
      ciphertext,
      iv,
      organizationId: toSafeId<"organization">(
        "0191d14d-9a63-7d2e-a021-06053e542c9a",
      ),
      purpose: "sharepoint_access_token",
      userId,
    });

    expect(await rejectionOf(decrypt)).not.toBeNull();
  });
});
