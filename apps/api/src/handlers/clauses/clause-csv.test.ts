import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { createSafeId } from "@/api/lib/branded-types";

import {
  deriveClauseSlug,
  parseClauseTags,
  serializeClauseTags,
} from "./clause-csv";

describe("clause CSV slugs", () => {
  test("normalizes supplied slugs with the same rules as derived slugs", () => {
    const clauseId = createSafeId<"clause">();

    expect(deriveClauseSlug("Ignored title", clauseId, " Custom / Slug ")).toBe(
      "custom-slug",
    );
  });

  test("uses a clause-specific unique fallback for non-Latin titles", () => {
    const clauseId = createSafeId<"clause">();

    expect(deriveClauseSlug("保密条款", clauseId, "")).toBe(
      `clause-${clauseId}`,
    );
  });
});

describe("clause CSV tags", () => {
  test("preserves commas and backslashes in individual tags", () => {
    const tags = ["standard", "civil, commercial", String.raw`path\segment`];

    expect(parseClauseTags(serializeClauseTags(tags))).toEqual(tags);
  });

  test("roundtrips trimmed non-empty tag lists without data loss", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .string({ minLength: 1 })
            .filter((tag) => tag.trim().length > 0 && tag === tag.trim()),
          { maxLength: 12 },
        ),
        (tags) => {
          expect(parseClauseTags(serializeClauseTags(tags))).toEqual(tags);
        },
      ),
      propertyConfig({ numRuns: 1000 }),
    );
  });
});
