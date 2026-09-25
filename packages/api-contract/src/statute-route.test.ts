import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  createStatuteIndexPath,
  createStatutePath,
  createStatuteRouteParams,
  createStatuteSlug,
  extractStatuteDocumentIdFromRouteParam,
  isStatuteSlug,
  normalizeStatuteStoredSlug,
  normalizeStatuteVersionSegment,
  parseStatutePath,
  STATUTE_SLUG_MAX_LENGTH,
  STATUTE_SLUG_PATTERN,
  toStatuteCountrySegment,
} from "./statute-route";

const DOCUMENT_ID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_DOCUMENT_ID = "AZ3UffUHfIS4J5gK8RuJgA";
const ELI = "/eli/cz/sb/2012/89";
const SLUG_SHAPE = new RegExp(STATUTE_SLUG_PATTERN, "u");

const routeParams = (
  overrides: Partial<Parameters<typeof createStatuteRouteParams>[0]>,
) =>
  createStatuteRouteParams({
    country: "cze",
    documentId: DOCUMENT_ID,
    eli: ELI,
    slug: null,
    version: null,
    ...overrides,
  });

const eliArbitrary = fc.oneof(
  fc
    .tuple(
      fc.integer({ min: 1, max: 999_999 }),
      fc.integer({ min: 1000, max: 2999 }),
      fc.constantFrom("sb", "zz", "ul1", "l"),
    )
    .map(
      ([number, year, collection]) => `/eli/cz/${collection}/${year}/${number}`,
    ),
  fc.string({ maxLength: 60 }),
);

describe("statute public slugs", () => {
  test("leads with the citation the ELI carries, then the short title", () => {
    expect(
      createStatuteSlug({
        eli: "/eli/cz/sb/2012/89",
        title: "89/2012 Sb., občanský zákoník",
      }),
    ).toBe("89-2012-sb-obcansky-zakonik");
    expect(
      createStatuteSlug({
        eli: "/eli/sk/zz/1964/40",
        title: "Občiansky zákonník",
      }),
    ).toBe("40-1964-zz-obciansky-zakonnik");
  });

  test("an ELI without a citation tail carries no slug", () => {
    expect(
      createStatuteSlug({ eli: "/eli/cz/sb", title: "Sbírka zákonů" }),
    ).toBeNull();
    expect(createStatuteSlug({ eli: "", title: "Anything" })).toBeNull();
  });

  test("the citation alone answers for a title that slugifies to nothing", () => {
    expect(createStatuteSlug({ eli: "/eli/cz/sb/2012/89", title: "§§§" })).toBe(
      "89-2012-sb",
    );
  });

  test("a derived slug always matches the column CHECK and the route param", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1000, max: 2999 }),
        fc.constantFrom("sb", "zz", "ul1", "l"),
        fc.string(),
        (number, year, collection, title) => {
          const slug = createStatuteSlug({
            eli: `/eli/cz/${collection}/${year}/${number}`,
            title,
          });

          expect(slug).not.toBeNull();
          expect(slug).toMatch(SLUG_SHAPE);
          expect(isStatuteSlug(slug ?? "")).toBe(true);
          expect((slug ?? "").length).toBeLessThanOrEqual(
            STATUTE_SLUG_MAX_LENGTH,
          );
        },
      ),
      propertyConfig(),
    );
  });

  test("distinct citations in one jurisdiction never share a segment", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 999_999 }),
          fc.integer({ min: 1000, max: 2999 }),
          fc.constantFrom("sb", "zz"),
        ),
        fc.tuple(
          fc.integer({ min: 1, max: 999_999 }),
          fc.integer({ min: 1000, max: 2999 }),
          fc.constantFrom("sb", "zz"),
        ),
        fc.string(),
        (
          [leftNumber, leftYear, leftCollection],
          [rightNumber, rightYear, rightCollection],
          title,
        ) => {
          fc.pre(
            leftNumber !== rightNumber ||
              leftYear !== rightYear ||
              leftCollection !== rightCollection,
          );

          const left = createStatuteSlug({
            eli: `/eli/cz/${leftCollection}/${leftYear}/${leftNumber}`,
            title,
          });
          const right = createStatuteSlug({
            eli: `/eli/cz/${rightCollection}/${rightYear}/${rightNumber}`,
            title,
          });

          expect(left).not.toBe(right);
        },
      ),
      propertyConfig(),
    );
  });

  test("rejects a segment the corpus could not have minted", () => {
    expect(isStatuteSlug("89-2012-sb")).toBe(true);
    expect(isStatuteSlug("89--2012")).toBe(false);
    expect(isStatuteSlug("-89-2012")).toBe(false);
    expect(isStatuteSlug("89_2012")).toBe(false);
    expect(isStatuteSlug("89-2012-SB")).toBe(false);
    expect(isStatuteSlug("a".repeat(STATUTE_SLUG_MAX_LENGTH + 1))).toBe(false);
  });

  test("refuses a stored value the API could not have minted", () => {
    expect(normalizeStatuteStoredSlug("89-2012-sb")).toBe("89-2012-sb");
    expect(normalizeStatuteStoredSlug("  89-2012-SB ")).toBe("89-2012-sb");
    expect(normalizeStatuteStoredSlug("89--2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("-89-2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("89 2012")).toBeNull();
    expect(normalizeStatuteStoredSlug("")).toBeNull();
    expect(normalizeStatuteStoredSlug(null)).toBeNull();
    expect(
      normalizeStatuteStoredSlug("a".repeat(STATUTE_SLUG_MAX_LENGTH + 1)),
    ).toBeNull();
  });
});

describe("public statute addresses", () => {
  test("the readable segment is the address of the latest consolidation", () => {
    const params = routeParams({
      country: "CZE",
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
    const params = routeParams({
      country: "svk",
      slug: "40-1964-zz-obciansky-zakonnik",
      version: "2021-01-01",
    });

    expect(createStatutePath(params)).toBe(
      "/law/svk/statutes/40-1964-zz-obciansky-zakonnik/v/2021-01-01",
    );
  });

  test("a document the corpus holds no slug for takes the id form", () => {
    const params = routeParams({
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
    expect(routeParams({ eli: null }).slug).toBe(
      `statute--${COMPACT_DOCUMENT_ID}`,
    );
  });

  test("a slug-less statute's param carries its id; a stored slug is the param", () => {
    const storedSlug = fc.oneof(
      fc.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      fc.string({ maxLength: 300 }),
    );

    fc.assert(
      fc.property(
        fc.uuid(),
        eliArbitrary,
        fc.option(storedSlug, { nil: null }),
        (documentId, eli, slug) => {
          const param = routeParams({ documentId, eli, slug }).slug;
          const idFromParam = extractStatuteDocumentIdFromRouteParam(param);
          const normalized = normalizeStatuteStoredSlug(slug);

          if (normalized === null) {
            expect(idFromParam).toBe(documentId.toLowerCase());
            return;
          }

          expect(param).toBe(normalized);
          // A stored slug must not read as an id form.
          expect(idFromParam).toBeNull();
        },
      ),
      propertyConfig(),
    );
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

describe("reading a statute address back", () => {
  const storedSlugArbitrary = fc.oneof(
    fc.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    fc.string({ maxLength: 40 }),
  );
  const versionArbitrary = fc.oneof(
    fc
      .date({
        min: new Date("1900-01-01T00:00:00Z"),
        max: new Date("2999-12-31T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10)),
    fc.string({ maxLength: 12 }),
  );

  test("reads back every path the builder writes", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 8 }), { nil: null }),
        fc.uuid(),
        eliArbitrary,
        fc.option(storedSlugArbitrary, { nil: null }),
        fc.option(versionArbitrary, { nil: null }),
        (country, documentId, eli, slug, version) => {
          const params = createStatuteRouteParams({
            country,
            documentId,
            eli,
            slug,
            version,
          });

          expect(parseStatutePath(createStatutePath(params))).toEqual(params);
        },
      ),
      propertyConfig(),
    );
  });

  test("reads back both address forms, with and without a version", () => {
    const withVersion = routeParams({
      slug: "89-2012-sb",
      version: "2021-01-01",
    });
    const idForm = routeParams({ slug: null });

    expect(withVersion.version).toBe("2021-01-01");
    expect(parseStatutePath(createStatutePath(withVersion))).toEqual(
      withVersion,
    );
    expect(idForm.slug).toBe(`89-2012-sb--${COMPACT_DOCUMENT_ID}`);
    expect(parseStatutePath(createStatutePath(idForm))).toEqual(idForm);
  });

  test("a path outside the statutes route is not a statute", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("cases", "statute", "decisions", "coverage"),
        fc.stringMatching(/^[a-z]{2,3}$/u),
        fc.array(fc.stringMatching(/^[a-z0-9-]{1,12}$/u), { maxLength: 4 }),
        (section, country, tail) => {
          expect(
            parseStatutePath(`/law/${country}/${section}/${tail.join("/")}`),
          ).toBeNull();
        },
      ),
      propertyConfig(),
    );
  });

  test("rejects a segment the builder could not have written", () => {
    for (const pathname of [
      "/law/cze/statutes",
      "/law/czechia/statutes/89-2012-sb",
      "/law/cze/statutes/89--2012",
      "/law/cze/statutes/89-2012-SB",
      "/law/cze/statutes/%E0%A4%A",
      "/law/cze/statutes/89-2012-sb/v",
      "/law/cze/statutes/89-2012-sb/v/latest",
      "/law/cze/statutes/89-2012-sb/x/2021-01-01",
      "/law/cze/statutes/89-2012-sb/v/2021-01-01/extra",
      // The id form names one consolidation; a `/v/` on it names it twice.
      `/law/cze/statutes/89-2012-sb--${COMPACT_DOCUMENT_ID}/v/2021-01-01`,
      "/workspaces/abc",
      "/",
    ]) {
      expect(parseStatutePath(pathname)).toBeNull();
    }
  });
});
