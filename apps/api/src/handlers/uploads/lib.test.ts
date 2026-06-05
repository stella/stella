import { describe, expect, test } from "bun:test";

import {
  legacyTmpUploadKey,
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
