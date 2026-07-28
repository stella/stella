import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Pin a faithful in-memory passthrough for the per-org envelope so these
// binding assertions exercise crypto.ts's real logic (mirrors the MCP
// crypto test; sibling suites mock this module globally). Dynamic import
// AFTER the mock so the binding takes effect.
void mock.module("@/api/lib/content-encryption", () => ({
  encryptContent: (_organizationId: unknown, plaintext: string) => ({
    ciphertext: Buffer.from(plaintext, "utf-8"),
    iv: Buffer.alloc(12),
  }),
  decryptContent: (_organizationId: unknown, ciphertext: Buffer) =>
    ciphertext.toString("utf-8"),
}));

const { decryptSharepointSecret, encryptSharepointSecret } =
  await import("@/api/handlers/sharepoint/crypto");

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
      // oxlint-disable-next-line no-await-in-loop -- sequential deterministic roundtrip check
      const { ciphertext, iv } = await encryptSharepointSecret({
        organizationId,
        purpose: "sharepoint_refresh_token",
        secret: payload,
        userId,
      });
      // oxlint-disable-next-line no-await-in-loop -- pairs with the encrypt above
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
});
