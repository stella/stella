import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { ASCII_FOLD_TABLE, foldToAscii } from "@stll/text-normalize";

import { rootDb } from "@/api/db/root";

/**
 * `foldToAscii` is the query-side half of a two-sided fold: global search
 * builds lexemes in JavaScript and matches them against a tsvector PostgreSQL
 * built over `unaccent(...)`. When the halves disagree on a single letter,
 * queries containing it under-match their own index, silently.
 *
 * So the table is not checked against a hand-written list here. It is
 * re-derived from the extension's own rules and compared in both directions,
 * which turns an `unaccent` upgrade that adds, drops, or retargets a Latin
 * rule into a CI failure rather than a search regression nobody notices.
 */

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type UnaccentRuleRow = {
  code_point: number;
  folded: string;
};

type UnaccentRule = {
  char: string;
  folded: string;
};

const LATIN_RE = /\p{Script=Latin}/u;

/**
 * Every code point the extension rewrites, restricted to the Latin script the
 * fold takes responsibility for. Surrogates are excluded because `chr()`
 * rejects them in a UTF-8 database.
 */
const loadLatinUnaccentRules = async (): Promise<UnaccentRule[]> => {
  const rows = await rootDb.execute<UnaccentRuleRow>(sql`
    SELECT cp::int AS code_point, unaccent(chr(cp::int)) AS folded
    FROM generate_series(1, 196607) AS cp
    WHERE NOT (cp BETWEEN 55296 AND 57343)
      AND unaccent(chr(cp::int)) IS DISTINCT FROM chr(cp::int)
  `);

  return rows.flatMap(({ code_point: codePoint, folded }) => {
    const char = String.fromCodePoint(codePoint);
    return LATIN_RE.test(char) ? [{ char, folded }] : [];
  });
};

if (runPostgresTests) {
  describe("foldToAscii / unaccent parity", () => {
    test("folds every Latin-script rule the extension declares", async () => {
      const rules = await loadLatinUnaccentRules();
      // A floor, not an equality: an empty or truncated rule set would let the
      // comparison below pass while proving nothing.
      expect(rules.length).toBeGreaterThan(400);

      expect(
        rules.filter(({ char, folded }) => foldToAscii(char) !== folded),
      ).toEqual([]);
    });

    test("declares no rule the extension does not", async () => {
      const declared = new Map(
        (await loadLatinUnaccentRules()).map(({ char, folded }) => [
          char,
          folded,
        ]),
      );

      expect(
        Object.entries(ASCII_FOLD_TABLE).filter(
          ([char, folded]) => declared.get(char) !== folded,
        ),
      ).toEqual([]);
    });

    test("keeps a ł query on the lexeme the index stored", async () => {
      const [row] = await rootDb.execute<{ tsv: string }>(sql`
        SELECT to_tsvector('public.stella_unaccent', 'łaska laska')::text AS tsv
      `);

      expect(row?.tsv).toBe("'laska':1,2");
      expect(foldToAscii("łaska")).toBe("laska");
    });
  });
} else {
  describe.skip("foldToAscii / unaccent parity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
}
