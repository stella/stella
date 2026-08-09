import { describe, expect, test } from "bun:test";

import { restrictCzRegionalFinaldocUrl } from "@/api/lib/legal-search/cz-regional-finaldoc-url";

describe("Czech regional court final-document URL restriction", () => {
  test("accepts only final-document paths on the court origin", () => {
    expect(
      restrictCzRegionalFinaldocUrl(
        "https://rozhodnuti.justice.cz/api/finaldoc/document-id",
      )?.toString(),
    ).toBe("https://rozhodnuti.justice.cz/api/finaldoc/document-id");
    expect(
      restrictCzRegionalFinaldocUrl(
        "https://rozhodnuti.justice.cz.evil.example/api/finaldoc/document-id",
      ),
    ).toBeNull();
    expect(
      restrictCzRegionalFinaldocUrl(
        "https://evil.rozhodnuti.justice.cz/api/finaldoc/document-id",
      ),
    ).toBeNull();
    expect(
      restrictCzRegionalFinaldocUrl(
        "https://rozhodnuti.justice.cz/api/finaldocumentation/document-id",
      ),
    ).toBeNull();
  });
});
