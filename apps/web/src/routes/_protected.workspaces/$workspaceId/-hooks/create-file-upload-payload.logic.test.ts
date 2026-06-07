import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";

import { buildEntityCreatePresignPayload } from "./create-file-upload-payload.logic";

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
});
