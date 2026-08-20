import { describe, expect, test } from "bun:test";

import { resolvePendingPdfCitationPageId } from "@/components/pdf/peek/pdf-citation-navigation.logic";
import { getPageId } from "@/lib/pdf/utils";

describe("queued PDF citation navigation", () => {
  test("waits for lazy page loading, then resolves in the exact viewer", () => {
    const request = { tabId: "field-cited", pageNumber: 6 };
    const pages = new Map<string, unknown>();

    expect(
      resolvePendingPdfCitationPageId({
        fieldId: "field-cited",
        pages,
        request,
      }),
    ).toBeUndefined();

    const citedPageId = getPageId("field-cited", 6);
    const otherPageId = getPageId("field-other", 6);
    pages.set(citedPageId, {});
    pages.set(otherPageId, {});
    expect(
      resolvePendingPdfCitationPageId({
        fieldId: "field-cited",
        pages,
        request,
      }),
    ).toBe(citedPageId);
    expect(
      resolvePendingPdfCitationPageId({
        fieldId: "field-other",
        pages,
        request,
      }),
    ).toBeUndefined();
  });
});
