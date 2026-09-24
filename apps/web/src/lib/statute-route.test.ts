import { describe, expect, test } from "bun:test";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import {
  createStatuteLinkTarget,
  isPublicStatuteCountry,
  STATUTE_COUNTRIES,
} from "@/lib/statute-route";

const DOCUMENT_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const ELI = "/eli/cz/sb/2012/89";

describe("statute link targets", () => {
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
