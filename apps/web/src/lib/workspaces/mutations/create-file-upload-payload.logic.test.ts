import { describe, expect, test } from "bun:test";

import { EmptyUploadFileError } from "@/lib/files/upload-file-validation";
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
    }).unwrap();

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
    const payload = buildEntityCreatePresignPayload(baseInput).unwrap();

    expect(payload.parentId).toBeNull();
  });

  test("rejects an empty file before a presign payload can be sent", () => {
    const result = buildEntityCreatePresignPayload({ ...baseInput, size: 0 });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(EmptyUploadFileError.is(result.error)).toBe(true);
      expect(result.error.message).toBe("The file is empty.");
    }
  });

  test("invalidates overview and activity once after the upload operation", () => {
    const workspaceId = "workspace_upload";

    expect(entityCreateLocalInvalidationKeys(workspaceId)).toEqual([
      entitiesKeys.all(workspaceId),
      workspacesKeys.overview(workspaceId),
    ]);
  });
});
