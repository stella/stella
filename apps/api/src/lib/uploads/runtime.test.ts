import { describe, expect, test } from "bun:test";

import { sha256Base64ToHex, sha256HexToBase64 } from "@stll/sha256";
import {
  sha256Hex as hashSha256Hex,
  createSha256,
  sha256Base64 as hashSha256Base64,
} from "@stll/sha256/bun";

import { toSafeId } from "@/api/lib/branded-types";
import {
  legacyTmpUploadKey,
  tmpUploadKey,
  tmpUploadKeys,
} from "@/api/lib/uploads/runtime";

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
    const hex = hashSha256Hex("the quick brown fox");
    expect(sha256Base64ToHex(sha256HexToBase64(hex))).toBe(hex);
  });

  test("hex->base64 matches Bun's own base64 digest", () => {
    const hasher = createSha256().update("payload bytes");
    const hex = hasher.digest("hex");
    const expectedBase64 = hashSha256Base64("payload bytes");
    expect(sha256HexToBase64(hex)).toBe(expectedBase64);
  });

  test("produced hex is the canonical 64-char lowercase form", () => {
    const base64 = hashSha256Base64("x");
    const hex = sha256Base64ToHex(base64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
  });
});
