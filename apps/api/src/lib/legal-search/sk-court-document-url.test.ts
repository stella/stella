import { describe, expect, test } from "bun:test";

import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";

describe("Slovak court document URL restriction", () => {
  test("accepts only public document paths on the court origin", () => {
    expect(
      restrictSkCourtDocumentUrl(
        "https://obcan.justice.sk/content/public/item/document-id",
      )?.toString(),
    ).toBe("https://obcan.justice.sk/content/public/item/document-id");
    expect(
      restrictSkCourtDocumentUrl(
        "https://127.0.0.1/content/public/item/document-id",
      ),
    ).toBeNull();
    expect(
      restrictSkCourtDocumentUrl(
        "https://obcan.justice.sk/private/item/document-id",
      ),
    ).toBeNull();
  });
});
