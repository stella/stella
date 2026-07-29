import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { encodeCursor } from "@/api/lib/search/cursor";
import {
  compareScoredSearchHits,
  decodeGlobalSearchCursor,
  globalSearchCursorSql,
  isAfterGlobalSearchCursor,
  paginateScoredSearchHits,
} from "@/api/lib/search/pagination";

type TestHit = {
  id: string;
};

const pageThrough = (
  source: readonly { hit: TestHit; score: number }[],
  limit: number,
): TestHit[] => {
  const sorted = source.toSorted(compareScoredSearchHits);
  const prefixes = ["entity:", "matter:", "contact:", "case-law:", "chat:"];
  const collected: TestHit[] = [];
  let cursor: { score: number; id: string } | null = null;

  for (;;) {
    const candidates = prefixes
      .flatMap((prefix) =>
        sorted
          .filter(
            ({ hit, score }) =>
              hit.id.startsWith(prefix) &&
              (cursor === null ||
                isAfterGlobalSearchCursor({ id: hit.id, score }, cursor)),
          )
          .slice(0, limit + 1),
      )
      .sort(compareScoredSearchHits);
    const page = paginateScoredSearchHits(candidates, limit);
    collected.push(...page.items);
    if (page.nextCursor === null) {
      return collected;
    }
    cursor = decodeGlobalSearchCursor(page.nextCursor);
    if (cursor === null) {
      throw new Error("pagination produced an invalid cursor");
    }
  }
};

describe("global search keyset pagination", () => {
  test("encodes the last returned score and globally unique id", () => {
    const page = paginateScoredSearchHits(
      [
        { hit: { id: "matter:3" }, score: 0.9 },
        { hit: { id: "entity:2" }, score: 0.8 },
        { hit: { id: "contact:1" }, score: 0.7 },
      ],
      2,
    );

    expect(page).toEqual({
      items: [{ id: "matter:3" }, { id: "entity:2" }],
      nextCursor: encodeCursor(0.8, "entity:2"),
    });
  });

  test("stops when the merged candidates contain no lookahead row", () => {
    expect(
      paginateScoredSearchHits(
        [
          { hit: { id: "matter:2" }, score: 0.9 },
          { hit: { id: "entity:1" }, score: 0.8 },
        ],
        2,
      ).nextCursor,
    ).toBeNull();
  });

  test("compiles a descending score/id boundary with C collation", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      globalSearchCursorSql({
        cursor: { score: 0.75, id: "case-law:decision_1" },
        score: sql`ts_rank(document, query)::float8`,
        id: sql`'case-law:' || decision_id::text`,
      }),
    );

    expect(compiled.sql).toContain("ts_rank(document, query)::float8 <");
    expect(compiled.sql).toContain('COLLATE "C" <');
    expect(compiled.params).toEqual([0.75, 0.75, "case-law:decision_1"]);
  });

  test("rejects cursors that do not identify a global search hit", () => {
    expect(decodeGlobalSearchCursor(encodeCursor(0.5, "global"))).toBeNull();
    expect(decodeGlobalSearchCursor(encodeCursor(0.5, "unknown:1"))).toBeNull();
  });

  test("repeated pages preserve the complete deterministic order", () => {
    const arbitraryHit = fc.record({
      id: fc
        .tuple(
          fc.constantFrom(
            "entity:",
            "matter:",
            "contact:",
            "case-law:",
            "chat:",
          ),
          fc.uuid(),
        )
        .map(([prefix, id]) => `${prefix}${id}`),
      score: fc.integer({ min: 0, max: 8 }),
    });

    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryHit, {
          minLength: 0,
          maxLength: 200,
          selector: ({ id }) => id,
        }),
        fc.integer({ min: 1, max: 40 }),
        (rows, limit) => {
          const source = rows.map(({ id, score }) => ({
            hit: { id },
            score,
          }));
          const expected = source
            .toSorted(compareScoredSearchHits)
            .map(({ hit }) => hit);

          expect(pageThrough(source, limit)).toEqual(expected);
        },
      ),
      propertyConfig(),
    );
  });
});
