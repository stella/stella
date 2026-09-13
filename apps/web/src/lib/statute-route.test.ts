import { describe, expect, test } from "bun:test";

import {
  createStatuteDocumentRouteParams,
  createStatuteIndexPath,
  createStatutePath,
  createStatuteRouteParams,
  isStatuteDocumentId,
  normalizeStatuteStoredSlug,
  normalizeStatuteVersionSegment,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

const DOCUMENT_ID = "01a019c1-953f-7000-8330-23bbc846adbe";

describe("public statute addresses", () => {
  test("the readable segment is the address of the latest consolidation", () => {
    const params = createStatuteRouteParams({
      country: "CZE",
      documentId: DOCUMENT_ID,
      slug: "89-2012-sb-obcansky-zakonik",
    });

    expect(params).toEqual({
      country: "cze",
      slug: "89-2012-sb-obcansky-zakonik",
    });
    expect(createStatutePath(params)).toBe(
      "/law/cze/statutes/89-2012-sb-obcansky-zakonik",
    );
  });

  test("a superseded consolidation hangs off the same segment", () => {
    const params = createStatuteRouteParams({
      country: "svk",
      documentId: DOCUMENT_ID,
      slug: "40-1964-zz-obciansky-zakonnik",
      version: "2021-01-01",
    });

    expect(createStatutePath(params)).toBe(
      "/law/svk/statutes/40-1964-zz-obciansky-zakonnik/v/2021-01-01",
    );
  });

  test("a document the corpus holds no slug for keeps the id address", () => {
    const params = createStatuteRouteParams({
      country: "cze",
      documentId: DOCUMENT_ID,
      slug: null,
      // An id already names one consolidation, so a version segment on it
      // would address the same text twice.
      version: "2021-01-01",
    });

    expect(params).toEqual({ country: "cze", slug: DOCUMENT_ID });
    expect(createStatutePath(params)).toBe(`/law/cze/statutes/${DOCUMENT_ID}`);
  });

  test("a dated citation addresses its own consolidation by id", () => {
    // The readable segment names the latest text, so a citation that means a
    // superseded wording must not be routed through it.
    expect(
      createStatuteDocumentRouteParams({
        country: "CZE",
        documentId: DOCUMENT_ID,
      }),
    ).toEqual({ country: "cze", slug: DOCUMENT_ID });
  });

  test("tells the id form from a minted slug", () => {
    expect(isStatuteDocumentId(DOCUMENT_ID)).toBe(true);
    expect(isStatuteDocumentId("89-2012-sb-obcansky-zakonik")).toBe(false);
    expect(isStatuteDocumentId("40-1964-zz")).toBe(false);
  });

  test("refuses a stored value the API could not have minted", () => {
    expect(normalizeStatuteStoredSlug("89-2012-sb")).toBe("89-2012-sb");
    expect(normalizeStatuteStoredSlug("  89-2012-SB ")).toBe("89-2012-sb");
    expect(normalizeStatuteStoredSlug("89--2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("-89-2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("89 2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("")).toBeNull();
    expect(normalizeStatuteStoredSlug(null)).toBeNull();
    expect(normalizeStatuteStoredSlug("a".repeat(257))).toBeNull();
  });

  test("a version segment is a calendar-shaped day or nothing", () => {
    expect(normalizeStatuteVersionSegment("2026-01-01")).toBe("2026-01-01");
    expect(normalizeStatuteVersionSegment("2026-1-1")).toBeNull();
    expect(normalizeStatuteVersionSegment("latest")).toBeNull();
    expect(normalizeStatuteVersionSegment(undefined)).toBeNull();
  });

  test("an unusable country falls back to the browser's default", () => {
    expect(toStatuteCountrySegment("SVK")).toBe("svk");
    expect(toStatuteCountrySegment(null)).toBe("cze");
    expect(toStatuteCountrySegment("czechia")).toBe("cze");
    expect(createStatuteIndexPath("POL")).toBe("/law/pol/statutes");
  });
});
