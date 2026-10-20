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

describe("user file thumbnail key ownership", () => {
  test("modules derive persisted thumbnail ids through the owner helper", async () => {
    const apiRoot = new URL("../..", import.meta.url).pathname;
    const violations: string[] = [];
    const thumbnailKeyCall =
      /createUserFileKey\s*\(\s*\{[\s\S]{0,400}?fileId\s*:\s*[^,\n]*thumbnailFileId/gu;

    for await (const relativePath of new Bun.Glob("**/*.ts").scan({
      cwd: apiRoot,
      onlyFiles: true,
    })) {
      if (relativePath === "src/lib/file-key.ts") {
        continue;
      }
      const source = await Bun.file(`${apiRoot}/${relativePath}`).text();
      if (thumbnailKeyCall.test(source)) {
        violations.push(relativePath);
      }
      thumbnailKeyCall.lastIndex = 0;
    }

    expect(violations).toEqual([]);
  });
});
