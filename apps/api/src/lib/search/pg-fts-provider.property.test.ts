import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import {
  buildPlainSearchTsQuery,
  buildSearchTsQuery,
} from "@/api/lib/search/query";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * User-query robustness for the Postgres FTS providers.
 *
 * `pgFtsProvider.search` (and the legal `pgFtsLegalProvider`) feed the
 * caller's raw query string into Postgres text-search functions via
 * `buildSearchTsQuery` / `buildPlainSearchTsQuery`. `to_tsquery` raises a
 * hard SQL error on unbalanced operators (`&`, `|`, `!`, `:`, `*`, `(`,
 * `)`), so any user query that reaches those functions unsanitized turns a
 * search box into a 500. The builders defend against this by reducing every
 * query to `[\p{L}\p{N}]+` lexemes before composing tsquery operators; this
 * suite pins that invariant against the *real* Postgres parser (a regex-only
 * check would miss how `to_tsquery` actually tokenizes).
 *
 * The builders wrap their arguments in `unaccent(...)`. PGlite ships no
 * `unaccent` extension, so we install an identity stub: `unaccent` only folds
 * accented characters to their base letters and can never introduce a tsquery
 * operator, so an identity function is sound for a *syntax-validity* property
 * (it exercises the exact same `to_tsquery`/`plainto_tsquery` parse path). The
 * repo's `arabic_normalize` SQL function is installed by `getTestDb`.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
  await db.execute(
    sql.raw(
      "CREATE OR REPLACE FUNCTION unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$",
    ),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

// A sampled `sample text نص قانون` document so a matching tsquery returns
// `true` and a non-matching one returns `false`; either way the parse must
// succeed. The boolean itself is irrelevant, only that no error is raised.
const runQuery = async (query: string): Promise<void> => {
  const built = buildSearchTsQuery(query);
  const plain = buildPlainSearchTsQuery(query, {});
  const plainAccented = buildPlainSearchTsQuery(query, { useUnaccent: true });
  await db.execute(
    sql`SELECT
      (to_tsvector('simple', 'sample text نص قانون') @@ ${built}) AS a,
      (to_tsvector('simple', 'sample') @@ ${plain}) AS b,
      (to_tsvector('simple', 'sample') @@ ${plainAccented}) AS c`,
  );
};

// Inputs that have historically broken naive tsquery construction: bare and
// unbalanced tsquery operators, quotes, prefix stars, boolean keywords,
// leading `-`, RTL/Arabic text mixed with operators, emoji, and
// empty/whitespace-only strings.
const ADVERSARIAL_QUERIES: readonly string[] = [
  "",
  "   ",
  "\t\n",
  "&",
  "|",
  "!",
  ":",
  "*",
  "(",
  ")",
  "()",
  "(((",
  ":::",
  "a & b",
  "a | b",
  "a:*)|(b",
  "foo:*",
  '"',
  '"unclosed',
  '"phrase"',
  "'",
  "'; DROP TABLE search_documents; --",
  "!!!",
  "a<->b",
  "AND OR NOT",
  "-foo",
  "- ",
  "foo AND (bar OR)",
  "قانون & (شركة",
  "شركة | !عقد",
  "مُحَمَّد:*",
  "😀🔥",
  "日本語 & 中文",
  "\\",
  "\\\\",
  "a\\:b",
];

describe("pg-fts tsquery robustness", () => {
  test("adversarial queries never raise a tsquery syntax error", async () => {
    for (const query of ADVERSARIAL_QUERIES) {
      // oxlint-disable-next-line no-await-in-loop -- sequential queries on one PGlite connection
      await runQuery(query);
    }
  });

  test(
    "arbitrary Unicode queries never raise a tsquery syntax error",
    async () => {
      // Bias toward tsquery metacharacters, Arabic script, boolean keywords,
      // and structural noise while still covering arbitrary Unicode (including
      // lone surrogates from `fc.string()`).
      const metaChar = fc.constantFrom(
        "&",
        "|",
        "!",
        ":",
        "*",
        "(",
        ")",
        '"',
        "'",
        "\\",
        "-",
        "<",
        ">",
        " ",
        "\t",
        "AND",
        "OR",
        "NOT",
        "قانون",
        "شركة",
        "عقد",
        "مُحَمَّد",
        "日本語",
        "😀",
        "a",
        "9",
      );
      const queryArb = fc.oneof(
        fc.string(),
        fc.array(metaChar, { maxLength: 12 }).map((parts) => parts.join("")),
        fc.array(metaChar, { maxLength: 12 }).map((parts) => parts.join(" ")),
      );

      // numRuns is capped at 60 (not the 200-1000 typical of pure in-memory
      // property tests, see src/handlers/rates/resolve.test.ts for the same
      // convention): every run does 3 real round-trips against the process-
      // wide shared PGlite singleton (test-utils.ts `getTestDb`), and PGlite's
      // WASM linear memory only ever grows for the life of an instance, never
      // shrinks. That singleton is reused by ~20 other test files across the
      // suite's single shared-process `bun test` run, so numRuns here adds
      // directly to the permanent memory floor for the rest of that run, not
      // just this file's own footprint. PR CI stays at this budget; the
      // nightly sweep still gets full depth via PROPERTY_TEST_NUM_RUNS_FACTOR.
      await fc.assert(
        fc.asyncProperty(queryArb, async (query) => {
          await runQuery(query);
        }),
        propertyConfig({ numRuns: 60 }),
      );
    },
    propertyTestTimeout(30_000),
  );

  test("a normal query still matches its document", async () => {
    const built = buildSearchTsQuery("sample text");
    const rows = await db.execute<{ m: boolean }>(
      sql`SELECT (to_tsvector('simple', 'sample text نص') @@ ${built}) AS m`,
    );
    expect(rows.rows.at(0)?.m).toBe(true);
  });
});
