import { describe, expect, test } from "bun:test";

import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/handlers/mcp-connectors/crypto";
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

const organizationId = toSafeId<"organization">("org-1");
const connectorId = toSafeId<"mcpConnector">("conn-1");
const userId = toSafeId<"user">("user-1");
const purpose = "mcp_access_token" as const;
const secret = "super-secret-access-token";

describe("encryptMcpSecret / decryptMcpSecret", () => {
  test("roundtrips on an exact connector/purpose/user match", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
      userId,
    });

    const decrypted = await decryptMcpSecret({
      ciphertext,
      connectorId,
      iv,
      organizationId,
      purpose,
      userId,
    });

    expect(String(decrypted)).toBe(secret);
  });

  test("roundtrips arbitrary secret payloads (invariant over the value space)", async () => {
    for (let i = 0; i < 64; i++) {
      const length = Math.floor(Math.random() * 256);
      const payload = Array.from({ length }, () =>
        String.fromCodePoint(Math.floor(Math.random() * 2 ** 16)),
      ).join("");

      const { ciphertext, iv } = await encryptMcpSecret({
        connectorId,
        organizationId,
        purpose,
        secret: payload,
        userId,
      });

      const decrypted = await decryptMcpSecret({
        ciphertext,
        connectorId,
        iv,
        organizationId,
        purpose,
        userId,
      });

      expect(String(decrypted)).toBe(payload);
    }
  });

  test("rejects a connectorId mismatch", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
      userId,
    });

    const decrypt = decryptMcpSecret({
      ciphertext,
      connectorId: toSafeId<"mcpConnector">("conn-2"),
      iv,
      organizationId,
      purpose,
      userId,
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  test("rejects a purpose mismatch", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
      userId,
    });

    const decrypt = decryptMcpSecret({
      ciphertext,
      connectorId,
      iv,
      organizationId,
      purpose: "mcp_refresh_token",
      userId,
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  test("rejects a userId mismatch", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
      userId,
    });

    const decrypt = decryptMcpSecret({
      ciphertext,
      connectorId,
      iv,
      organizationId,
      purpose,
      userId: toSafeId<"user">("user-2"),
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  // The guard arms whenever the caller supplies a userId. A stored envelope
  // minted WITHOUT a userId is treated as a mismatch (the absent envelope
  // userId fails the `"userId" in parsed` check), so supplying any userId at
  // decrypt time rejects. The user-scoping check is fail-closed: a caller
  // claiming a user identity cannot read an envelope that asserts no owner.
  test("rejects a user-less envelope when a userId is supplied", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
    });

    const decrypt = decryptMcpSecret({
      ciphertext,
      connectorId,
      iv,
      organizationId,
      purpose,
      userId,
    });

    expect(await rejectionOf(decrypt)).toBeInstanceOf(HandlerError);
  });

  // A user-less envelope decrypts when no userId is supplied: the guard never
  // arms because the caller passes no userId.
  test("decrypts a user-less envelope when no userId is supplied", async () => {
    const { ciphertext, iv } = await encryptMcpSecret({
      connectorId,
      organizationId,
      purpose,
      secret,
    });

    const decrypted = await decryptMcpSecret({
      ciphertext,
      connectorId,
      iv,
      organizationId,
      purpose,
    });

    expect(String(decrypted)).toBe(secret);
  });
});
