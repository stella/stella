import { describe, expect, test } from "bun:test";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import {
  createStatuteIndexPath,
  createStatuteLinkTarget,
  createStatutePath,
  createStatuteRouteParams,
  extractStatuteDocumentIdFromRouteParam,
  normalizeStatuteStoredSlug,
  normalizeStatuteVersionSegment,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

import { isPublicStatuteCountry, STATUTE_COUNTRIES } from "./statute-route";

const DOCUMENT_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_DOCUMENT_ID = "AZ3UffUHfIS4J5gK8RuJgA";
const ELI = "/eli/cz/sb/2012/89";

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

  test("a document the corpus holds no slug for takes the id form", () => {
    const params = createStatuteRouteParams({
      country: "cze",
      documentId: DOCUMENT_ID,
      eli: ELI,
      slug: null,
      // The id form already names one consolidation, so a version segment on
      // it would address the same text twice.
      version: "2021-01-01",
    });

    expect(params).toEqual({
      country: "cze",
      slug: `89-2012-sb--${COMPACT_DOCUMENT_ID}`,
    });
    expect(createStatutePath(params)).toBe(
      `/law/cze/statutes/89-2012-sb--${COMPACT_DOCUMENT_ID}`,
    );
  });

  test("the id form falls back to a fixed prefix without an identifier", () => {
    expect(
      createStatuteRouteParams({
        country: "cze",
        documentId: DOCUMENT_ID,
        slug: null,
      }).slug,
    ).toBe(`statute--${COMPACT_DOCUMENT_ID}`);
  });

  test("reads the document id back out of the id form only", () => {
    expect(
      extractStatuteDocumentIdFromRouteParam(
        `89-2012-sb--${COMPACT_DOCUMENT_ID}`,
      ),
    ).toBe(DOCUMENT_ID);
    // A plain slug carries no id, and a bare uuid is not an address at all.
    expect(
      extractStatuteDocumentIdFromRouteParam("89-2012-sb-obcansky-zakonik"),
    ).toBeNull();
    expect(extractStatuteDocumentIdFromRouteParam(DOCUMENT_ID)).toBeNull();
    expect(
      extractStatuteDocumentIdFromRouteParam("89-2012-sb--nope"),
    ).toBeNull();
  });

  test("a citation link names the consolidation it means", () => {
    // A dated citation must not route through the bare slug, which names
    // whatever consolidation is latest.
    expect(
      createStatuteLinkTarget({
        country: "CZE",
        documentId: DOCUMENT_ID,
        eli: ELI,
        slug: "89-2012-sb-obcansky-zakonik",
        versionValidFrom: "2021-01-01",
      }),
    ).toEqual({
      params: {
        country: "cze",
        slug: "89-2012-sb-obcansky-zakonik",
        version: "2021-01-01",
      },
      to: "/law/$country/statutes/$slug/v/$version",
    });
    expect(
      createStatuteLinkTarget({
        country: "CZE",
        documentId: DOCUMENT_ID,
        eli: ELI,
        slug: "89-2012-sb-obcansky-zakonik",
        versionValidFrom: null,
      }),
    ).toEqual({
      params: { country: "cze", slug: "89-2012-sb-obcansky-zakonik" },
      to: "/law/$country/statutes/$slug",
    });
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

test("public statute routes follow the shared jurisdiction admission list", () => {
  expect(
    Object.keys(STATUTE_COUNTRIES)
      .filter(isPublicStatuteCountry)
      .map((country) => country.toUpperCase()),
  ).toEqual([...PUBLIC_LEGISLATION_COUNTRIES]);
  expect(isPublicStatuteCountry("svk")).toBe(false);
  expect(isPublicStatuteCountry("xaa")).toBe(false);
});
