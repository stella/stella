import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { storedKeyForOrganization } from "@/api/lib/file-key";

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
