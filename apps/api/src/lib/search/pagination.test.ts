import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  compareScoredSearchHits,
  decodeGlobalSearchCursor,
  encodeGlobalSearchCursor,
  GLOBAL_SEARCH_HIT_ID_PREFIXES,
  GLOBAL_SEARCH_RESULT_LIMIT,
  globalSearchCursorSql,
  isAfterGlobalSearchCursor,
  paginateScoredSearchHits,
  parseGlobalSearchCursor,
} from "@/api/lib/search/pagination";

type TestHit = {
  id: string;
};

type TestScoredHit = {
  hit: TestHit;
  score: number;
};

const candidatesAfterCursor = ({
  sorted,
  prefixes,
  cursor,
  limit,
}: {
  sorted: readonly TestScoredHit[];
  prefixes: readonly string[];
  cursor: ReturnType<typeof decodeGlobalSearchCursor>;
  limit: number;
}) =>
  prefixes
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

const pageThrough = (
  source: readonly { hit: TestHit; score: number }[],
  limit: number,
): TestHit[] => {
  const sorted = source.toSorted(compareScoredSearchHits);
  const collected: TestHit[] = [];
  let cursor: ReturnType<typeof decodeGlobalSearchCursor> = null;

  for (;;) {
    const candidates = candidatesAfterCursor({
      sorted,
      prefixes: GLOBAL_SEARCH_HIT_ID_PREFIXES,
      cursor,
      limit,
    });
    const page = paginateScoredSearchHits({
      scoredHits: candidates,
      limit,
      seen: cursor?.seen ?? 0,
    });
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
    const page = paginateScoredSearchHits({
      scoredHits: [
        { hit: { id: "matter:3" }, score: 0.9 },
        { hit: { id: "entity:2" }, score: 0.8 },
        { hit: { id: "contact:1" }, score: 0.7 },
      ],
      limit: 2,
      seen: 0,
    });

    expect(page).toEqual({
      items: [{ id: "matter:3" }, { id: "entity:2" }],
      nextCursor: encodeGlobalSearchCursor({
        score: 0.8,
        id: "entity:2",
        seen: 2,
      }),
    });
  });

  test("keeps new cursors consumable by legacy replicas", () => {
    const cursor = encodeGlobalSearchCursor({
      score: 0.8,
      id: "entity:2",
      seen: 25,
    });

    expect(decodeCursor(cursor)).toEqual({ score: 25, id: "global" });
    expect(parseGlobalSearchCursor(cursor)).toEqual({
      type: "keyset",
      cursor: { score: 0.8, id: "entity:2", seen: 25 },
    });
  });

  test("recognizes cursors issued by legacy replicas", () => {
    expect(parseGlobalSearchCursor(encodeCursor(25, "global"))).toEqual({
      type: "legacy",
      offset: 25,
    });
    expect(parseGlobalSearchCursor(encodeCursor(100, "global"))).toEqual({
      type: "legacy",
      offset: 100,
    });
  });

  test("dual cursors preserve both formats for every supported position", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: GLOBAL_SEARCH_RESULT_LIMIT - 1 }),
        fc.integer({ min: -8, max: 8 }),
        fc.constantFrom(...GLOBAL_SEARCH_HIT_ID_PREFIXES),
        fc.uuid(),
        (seen, score, prefix, id) => {
          const keysetCursor = { score, id: `${prefix}${id}`, seen };
          const encoded = encodeGlobalSearchCursor(keysetCursor);

          expect(decodeCursor(encoded)).toEqual({ score: seen, id: "global" });
          expect(parseGlobalSearchCursor(encoded)).toEqual({
            type: "keyset",
            cursor: keysetCursor,
          });
          expect(parseGlobalSearchCursor(encodeCursor(seen, "global"))).toEqual(
            { type: "legacy", offset: seen },
          );
        },
      ),
      propertyConfig(),
    );
  });

  test("stops when the merged candidates contain no lookahead row", () => {
    expect(
      paginateScoredSearchHits({
        scoredHits: [
          { hit: { id: "matter:2" }, score: 0.9 },
          { hit: { id: "entity:1" }, score: 0.8 },
        ],
        limit: 2,
        seen: 0,
      }).nextCursor,
    ).toBeNull();
  });

  test("stops at the established global result horizon", () => {
    const page = paginateScoredSearchHits({
      scoredHits: Array.from({ length: 11 }, (_, index) => ({
        hit: { id: `entity:${index}` },
        score: 11 - index,
      })),
      limit: 25,
      seen: GLOBAL_SEARCH_RESULT_LIMIT - 10,
    });

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  test("compiles a descending score/id boundary with C collation", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      globalSearchCursorSql({
        cursor: { score: 0.75, id: "case-law:decision_1", seen: 10 },
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
    expect(
      decodeGlobalSearchCursor(
        encodeCursor(0.5, `${GLOBAL_SEARCH_RESULT_LIMIT}:entity:1`),
      ),
    ).toBeNull();
    expect(
      decodeGlobalSearchCursor(encodeCursor(0.5, "0:entity:1")),
    ).toBeNull();
    expect(
      decodeGlobalSearchCursor(encodeCursor(0.5, "-1:entity:1")),
    ).toBeNull();
  });

  test("repeated pages preserve the complete deterministic order", () => {
    const arbitraryHit = fc.record({
      id: fc
        .tuple(fc.constantFrom(...GLOBAL_SEARCH_HIT_ID_PREFIXES), fc.uuid())
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
