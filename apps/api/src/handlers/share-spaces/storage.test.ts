import { describe, expect, test } from "bun:test";

import {
  createShareDisplayStorageKey,
  createShareOriginalStorageKey,
  createShareThumbnailStorageKey,
} from "@/api/handlers/share-spaces/storage";
import { toSafeId } from "@/api/lib/branded-types";

describe("Share Space storage keys", () => {
  test("keeps every publication asset inside one share-owned item prefix", () => {
    const options = {
      organizationId: toSafeId<"organization">("org_test"),
      shareSpaceId: toSafeId<"shareSpace">(
        "019c1234-1234-7000-8000-123456789abc",
      ),
      shareItemId: toSafeId<"shareItem">(
        "019c1234-1234-7000-8000-abcdef123456",
      ),
    };
    const prefix =
      "organizations/org_test/share-spaces/019c1234-1234-7000-8000-123456789abc/items/019c1234-1234-7000-8000-abcdef123456";

    expect(
      createShareOriginalStorageKey({
        ...options,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(`${prefix}/original.docx`);
    expect(
      createShareDisplayStorageKey({
        ...options,
        mimeType: "application/pdf",
      }),
    ).toBe(`${prefix}/display.pdf`);
    expect(createShareThumbnailStorageKey(options)).toBe(
      `${prefix}/thumbnail.webp`,
    );
  });
});
