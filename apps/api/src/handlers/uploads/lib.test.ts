import { describe, expect, test } from "bun:test";

import {
  legacyTmpUploadKey,
  sha256Base64ToHex,
  sha256HexToBase64,
  tmpUploadKey,
  tmpUploadKeys,
} from "@/api/handlers/uploads/lib";
import { toSafeId } from "@/api/lib/branded-types";

const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");
const uploadId = toSafeId<"pendingUpload">("upload_1");

describe("tmp upload keys", () => {
  test("stages new uploads under the organization/workspace prefix", () => {
    expect(tmpUploadKey({ organizationId, uploadId, workspaceId })).toBe(
      "org_1/ws_1/tmp/upload_1",
    );
  });

  test("keeps legacy tmp key fallback for pending upload migration", () => {
    expect(legacyTmpUploadKey(uploadId)).toBe("tmp/upload_1");
    expect(tmpUploadKeys({ organizationId, uploadId, workspaceId })).toEqual([
      "org_1/ws_1/tmp/upload_1",
      "tmp/upload_1",
    ]);
  });
});

describe("SHA-256 hex <-> base64 (S3 checksum integrity gate)", () => {
  test("round-trips an arbitrary digest back to lowercase hex", () => {
    const hex = new Bun.CryptoHasher("sha256")
      .update("the quick brown fox")
      .digest("hex");
    expect(sha256Base64ToHex(sha256HexToBase64(hex))).toBe(hex);
  });

  test("hex->base64 matches Bun's own base64 digest", () => {
    const hasher = new Bun.CryptoHasher("sha256").update("payload bytes");
    const hex = hasher.digest("hex");
    const expectedBase64 = new Bun.CryptoHasher("sha256")
      .update("payload bytes")
      .digest("base64");
    expect(sha256HexToBase64(hex)).toBe(expectedBase64);
  });

  test("produced hex is the canonical 64-char lowercase form", () => {
    const base64 = new Bun.CryptoHasher("sha256").update("x").digest("base64");
    const hex = sha256Base64ToHex(base64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
  });
});
