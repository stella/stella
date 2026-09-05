import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import {
  buildEntityCreatePresignPayload,
  entityCreateLocalInvalidationKeys,
} from "./create-file-upload-payload.logic";

const baseInput = {
  propertyId: "property_upload",
  name: "message.eml",
  mimeType: "message/rfc822",
  size: 123,
  sha256Hex: "a".repeat(64),
};

describe("entity-create upload payload", () => {
  test("threads the current folder parent into presign", () => {
    const payload = buildEntityCreatePresignPayload({
      ...baseInput,
      parentId: "entity_folder",
    });

    expect(payload).toEqual({
      purpose: "entity_create",
      propertyId: toSafeId<"property">("property_upload"),
      parentId: toSafeId<"entity">("entity_folder"),
      name: "message.eml",
      mimeType: "message/rfc822",
      size: 123,
      sha256Hex: "a".repeat(64),
    });
  });

  test("sends root uploads as an explicit null parent", () => {
    const payload = buildEntityCreatePresignPayload(baseInput);

    expect(payload.parentId).toBeNull();
  });

  test("preserves zero-byte file sizes", () => {
    const payload = buildEntityCreatePresignPayload({
      ...baseInput,
      size: 0,
    });

    expect(payload.size).toBe(0);
  });

  test("invalidates overview and activity once after the upload operation", () => {
    const workspaceId = "workspace_upload";

    expect(entityCreateLocalInvalidationKeys(workspaceId)).toEqual([
      entitiesKeys.all(workspaceId),
      workspacesKeys.overview(workspaceId),
    ]);
  });
});
