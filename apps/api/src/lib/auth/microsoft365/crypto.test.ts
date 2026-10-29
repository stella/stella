import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readFailureBrand } from "@stll/errors";

import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/lib/auth/microsoft365/crypto";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
      expect(String(decrypted.unwrap())).toBe(payload);
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

    const result = await decrypt;
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(readFailureBrand(result.error)?.reason).toBe(
        "credentials_token_unreadable",
      );
      expect(result.error).toMatchObject({
        status: 500,
        message: "Stored SharePoint secret envelope is invalid",
      });
    }
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

    const result = await decrypt;
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(readFailureBrand(result.error)?.reason).toBe(
        "credentials_token_unreadable",
      );
      expect(result.error).toMatchObject({
        status: 500,
        message: "Stored SharePoint secret envelope is invalid",
      });
    }
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

    const result = await decrypt;
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(readFailureBrand(result.error)?.reason).toBe(
        "credentials_token_unreadable",
      );
      expect(result.error.cause).toBeInstanceOf(DOMException);
    }
  });
});

test("rejects altered ciphertext without losing its cryptographic cause", async () => {
  const { ciphertext, iv } = await encryptSharepointSecret({
    organizationId,
    purpose: "sharepoint_access_token",
    secret,
    userId,
  });
  const altered = Buffer.from(ciphertext);
  expect(altered.length).toBeGreaterThan(0);
  altered[0] = altered.readUInt8(0) === 0 ? 1 : 0;
  expect(altered).not.toEqual(ciphertext);
  const result = await decryptSharepointSecret({
    ciphertext: altered,
    iv,
    organizationId,
    purpose: "sharepoint_access_token",
    userId,
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 500,
      message: "Stored SharePoint secret envelope is invalid",
    });
    expect(result.error.cause).toBeInstanceOf(DOMException);
  }
});

test("invalid JSON and envelope fields retain typed unreadable failures without decrypted diagnostics", async () => {
  const privateValue = "stored-private-token";
  for (const plaintext of [
    `{"secret":"${privateValue}"`,
    JSON.stringify({
      purpose: "sharepoint_access_token",
      userId,
      secret: 1,
      privateValue,
    }),
  ]) {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);
    const result = await decryptSharepointSecret({
      ciphertext,
      iv,
      organizationId,
      purpose: "sharepoint_access_token",
      userId,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 500,
        message: "Stored SharePoint secret envelope is invalid",
      });
      expect(readFailureBrand(result.error)?.reason).toBe(
        "credentials_token_unreadable",
      );
      expect(JSON.stringify(result.error)).not.toContain(privateValue);
    }
  }
});
