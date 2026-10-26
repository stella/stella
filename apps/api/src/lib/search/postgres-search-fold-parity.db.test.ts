import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";
import {
  foldLikePostgresSearch,
  POSTGRES_UNACCENT_RULES,
} from "@stll/text-normalize";

import { rootDb } from "@/api/db/root";
import { findTermMatches } from "@/api/lib/entity-filters";
import { typedPgArray } from "@/api/lib/search/sql";

/**
 * A find matches in PostgreSQL (`search_fold`) and is highlighted in the
 * browser (`foldLikePostgresSearch`). When the two folds disagree on one
 * character, the grid shows rows with nothing marked, or marks text the
 * server never matched, silently.
 *
 * So the client fold is not checked against a hand-written list here: the
 * extension's rules and the database's case mapping are read back and
 * compared in both directions, which turns an `unaccent` upgrade or a
 * collation change into a CI failure rather than a highlighting regression.
 */

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type CodePointRow = {
  code_point: number;
  folded: string;
};

const LAST_CODE_POINT = 196_607;

/** Every code point the extension rewrites. `chr()` rejects surrogates. */
const loadUnaccentRules = async (): Promise<Map<string, string>> => {
  const rows = await rootDb.execute<CodePointRow>(sql`
    SELECT cp::int AS code_point, unaccent(chr(cp::int)) AS folded
    FROM generate_series(1, ${LAST_CODE_POINT}::int) AS cp
    WHERE NOT (cp BETWEEN 55296 AND 57343)
      AND unaccent(chr(cp::int)) IS DISTINCT FROM chr(cp::int)
  `);
  return new Map(
    rows.map(({ code_point: codePoint, folded }) => [
      String.fromCodePoint(codePoint),
      folded,
    ]),
  );
};

// Cased letters, symbols the extension expands, the marks it deletes, and
// the full-width LIKE metacharacters it turns into ASCII ones.
const FIND_TOKENS = Object.freeze([
  "a",
  "A",
  "e",
  "é",
  "É",
  "ř",
  "Ř",
  "ü",
  "ß",
  "ss",
  "Æ",
  "ae",
  "ł",
  "İ",
  "i",
  "ı",
  "Σ",
  "σ",
  "ς",
  "Ё",
  "е",
  "½",
  " 1/2",
  "©",
  "(c)",
  "ǅ",
  "dž",
  "%",
  "_",
  "\\",
  "％",
  "＿",
  "＼",
  " ",
  "😀",
]);

const findText = (maxLength: number) =>
  fc
    .array(fc.constantFrom(...FIND_TOKENS), { maxLength })
    .map((parts) => parts.join(""));

if (!runPostgresTests) {
  describe.skip("search_fold / foldLikePostgresSearch parity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
} else {
  describe("search_fold / foldLikePostgresSearch parity", () => {
    test("the client table holds every unaccent rule and no other", async () => {
      const rules = await loadUnaccentRules();
      // A floor, not an equality: an empty or truncated rule set would let
      // the comparisons below pass while proving nothing.
      expect(rules.size).toBeGreaterThan(2000);

      const declared = new Map(Object.entries(POSTGRES_UNACCENT_RULES));
      expect(
        [...rules].filter(([char, folded]) => declared.get(char) !== folded),
      ).toEqual([]);
      expect(
        [...declared].filter(([char, folded]) => rules.get(char) !== folded),
      ).toEqual([]);
    });

    test("folds every assigned code point the way the database does", async () => {
      // Assigned in the database's Unicode version: a code point it does not
      // know yet has no case mapping there, whatever the JavaScript engine's
      // newer tables say.
      const rows = await rootDb.execute<CodePointRow>(sql`
        SELECT cp::int AS code_point, search_fold(chr(cp::int)) AS folded
        FROM generate_series(1, ${LAST_CODE_POINT}::int) AS cp
        WHERE NOT (cp BETWEEN 55296 AND 57343)
          AND unicode_assigned(chr(cp::int))
      `);
      expect(rows.length).toBeGreaterThan(100_000);

      expect(
        rows
          .filter(
            ({ code_point: codePoint, folded }) =>
              foldLikePostgresSearch(String.fromCodePoint(codePoint)) !==
              folded,
          )
          .map(({ code_point: codePoint, folded }) => ({
            codePoint: codePoint.toString(16),
            client: foldLikePostgresSearch(String.fromCodePoint(codePoint)),
            server: folded,
          })),
      ).toEqual([]);
    });

    test("folds whole strings the way it folds their code points", async () => {
      // The per-code-point comparison above proves a string only if the fold
      // is compositional; these hold that across languages and mark orders.
      const samples = [
        "Antonín Dvořák",
        "DVOŘÁK",
        "Jürgen Müller-Straße",
        "Élise Lefèvre",
        "Łódź, Wrocław",
        "İstanbul ıspanak",
        "ΟΔΥΣΣΕΥΣ",
        "Ёлка",
        "café ｆｕｌｌｗｉｄｔｈ ５０％",
        "½ © ǅ Æ",
      ];
      const rows = await rootDb.execute<{ folded: string }>(sql`
        SELECT search_fold(sample) AS folded
        FROM unnest(${typedPgArray(samples, "text")}) WITH ORDINALITY AS input(sample, position)
        ORDER BY position
      `);

      expect(rows.map(({ folded }) => folded)).toEqual(
        samples.map(foldLikePostgresSearch),
      );
    });

    test("a find matches exactly where the highlighter marks", async () => {
      await assertProperty(
        "a find matches exactly where the highlighter marks",
        fc.asyncProperty(findText(8), findText(4), async (value, term) => {
          const [row] = await rootDb.execute<{ matched: boolean }>(
            sql`SELECT ${findTermMatches(sql`${value}::text`, term)} AS matched`,
          );

          expect(row?.matched).toBe(
            foldLikePostgresSearch(value).includes(
              foldLikePostgresSearch(term),
            ),
          );
        }),
        propertyConfig({ numRuns: 200 }),
      );
    });

    test("a full-width wildcard in a term matches only itself", async () => {
      // `unaccent` maps `％` to `%`, so a term escaped before folding would
      // turn into a wildcard and match `50x`.
      const values = ["５０％ off", "50% off", "50x off"];
      const rows = await rootDb.execute<{ matched: boolean }>(sql`
        SELECT ${findTermMatches(sql`candidate`, "50％")} AS matched
        FROM unnest(${typedPgArray(values, "text")}) WITH ORDINALITY AS input(candidate, position)
        ORDER BY position
      `);

      expect(rows.map(({ matched }) => matched)).toEqual([true, true, false]);
    });
  });
}
