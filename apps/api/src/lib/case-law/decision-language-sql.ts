import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { DECISION_AUTHENTIC_LANGUAGE_METADATA_KEY } from "@/api/lib/case-law/decision-language";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

// The reading order of language versions, in SQL, for the read handlers. Kept
// apart from `decision-language.ts`, which parsers import, so a read-side
// query change never reaches parser output.

/**
 * The authority codes a CJEU notice states the language of the case in, as
 * the row language tags `authenticLanguageTag` reads them to. Spelled out for
 * the database, which has no `Intl.Locale` to canonicalise them; a test holds
 * every entry to `authenticLanguageTag`, so the two readings cannot drift.
 */
export const AUTHORITY_LANGUAGE_TAGS = {
  BUL: "bg",
  CES: "cs",
  DAN: "da",
  DEU: "de",
  ELL: "el",
  ENG: "en",
  EST: "et",
  FIN: "fi",
  FRA: "fr",
  GLE: "ga",
  HRV: "hr",
  HUN: "hu",
  ITA: "it",
  LAV: "lv",
  LIT: "lt",
  MLT: "mt",
  NLD: "nl",
  POL: "pl",
  POR: "pt",
  RON: "ro",
  SLK: "sk",
  SLV: "sl",
  SPA: "es",
  SWE: "sv",
} as const satisfies Record<string, string>;

/** A row's language as its primary subtag: `pt_BR` and `pt-br` read `pt`. */
const primaryLanguageSql = (language: SQL | AnyPgColumn) =>
  sql`split_part(replace(lower(${language}), '_', '-'), '-', 1)`;

/** The language of the case a row's metadata states, as a row tag, or null. */
const authenticLanguageSql = (metadata: SQL | AnyPgColumn) => {
  const code = sql`upper(${metadata} -> ${sql.raw(`'${DECISION_AUTHENTIC_LANGUAGE_METADATA_KEY}'`)} -> 0 ->> 'code')`;
  const branches = Object.entries(AUTHORITY_LANGUAGE_TAGS).map(
    ([authority, tag]) => sql.raw(`WHEN '${authority}' THEN '${tag}'`),
  );
  return sql`(${sqlCaseFragment({ branches, fallback: sql`NULL`, operand: code })})`;
};

/**
 * Where a language version stands in the reader's order, in SQL: its reading
 * language's position, then the language of the case, then every other
 * version. The same order as `caseLawLanguageVersionRank`; lower is
 * preferred, and a tie is left to the caller's own order (the oldest
 * version).
 */
export const languageVersionRankSql = (
  row: { language: SQL | AnyPgColumn; metadata: SQL | AnyPgColumn },
  readingLanguages: readonly string[],
) => {
  const primary = primaryLanguageSql(row.language);
  const count = readingLanguages.length;
  return sql`coalesce(
    array_position(string_to_array(${readingLanguages.join(",")}, ','), ${primary}) - 1,
    CASE WHEN ${primary} = ${authenticLanguageSql(row.metadata)}
      THEN ${count}::int ELSE ${count + 1}::int END
  )`;
};
