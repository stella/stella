import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { STATUTE_SLUG_SQL_PATTERN } from "@/api/db/schema";
import {
  createStatuteSlug,
  isStatuteSlug,
} from "@/api/handlers/legislation/slug";

const SLUG_SHAPE = new RegExp(STATUTE_SLUG_SQL_PATTERN, "u");

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

  test("every consolidation of one Work derives the same segment", () => {
    const work = {
      eli: "/eli/cz/sb/2012/89",
      title: "89/2012 Sb., občanský zákoník",
    };

    expect(createStatuteSlug(work)).toBe(createStatuteSlug({ ...work }));
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
          expect((slug ?? "").length).toBeLessThanOrEqual(256);
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
    expect(isStatuteSlug("a".repeat(257))).toBe(false);
  });
});
