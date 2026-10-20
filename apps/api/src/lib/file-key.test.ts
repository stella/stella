import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  createUserFileThumbnailKey,
  storedKeyForOrganization,
  storedUserFileKey,
} from "@/api/lib/file-key";

describe("stored object organization keys", () => {
  const organizationId = toSafeId<"organization">("org_1");

  test("accepts a key under the row organization", () => {
    expect(
      storedKeyForOrganization("org_1/templates/template.docx", organizationId),
    ).toBe("org_1/templates/template.docx");
  });

  test("refuses a key under another organization", () => {
    expect(
      storedKeyForOrganization("org_2/templates/template.docx", organizationId),
    ).toBeNull();
  });
});

describe("stored user file keys", () => {
  const organizationId = toSafeId<"organization">("org_1");
  const uploaderUserId = toSafeId<"user">("user_1");

  test.each(["org_1/attachment.pdf", "user_1/attachment.pdf"])(
    "accepts an organization- or uploader-owned key",
    (key) => {
      expect(storedUserFileKey({ key, organizationId, uploaderUserId })).toBe(
        key,
      );
    },
  );

  test.each(["org_2/attachment.pdf", "user_2/attachment.pdf", "unowned.pdf"])(
    "refuses a key owned by neither organization nor uploader",
    (key) => {
      expect(
        storedUserFileKey({ key, organizationId, uploaderUserId }),
      ).toBeNull();
    },
  );

  test("keeps a legacy thumbnail under its uploader prefix", () => {
    expect(
      String(
        createUserFileThumbnailKey({
          sourceKey: "user_1/attachment.png",
          thumbnailFileId: "0199f000-0000-7000-8000-000000000001",
          organizationId,
          uploaderUserId,
        }),
      ),
    ).toBe("user_1/0199f000-0000-7000-8000-000000000001.webp");
  });
});
