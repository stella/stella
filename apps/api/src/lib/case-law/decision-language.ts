import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

const LANGUAGE_SEGMENT_REGEX = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

/** Lower-case BCP-47-ish tag, or null when the input is not one. */
export const normalizePublicDecisionLanguage = (
  language: string | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized) {
    return null;
  }

  return LANGUAGE_SEGMENT_REGEX.test(normalized) ? normalized : null;
};

/**
 * Metadata key under which a source states the language the decision was
 * given in, as authority concepts (`[{ code: "ENG", … }]`): the language of
 * the case of a CJEU decision, which is the only authentic version of it.
 * The CJEU adapter writes it from the notice; readers choosing a language
 * version read it from here.
 */
export const DECISION_AUTHENTIC_LANGUAGE_METADATA_KEY = "procedureLanguage";

/**
 * The version read when a decision's own language is not stated, or is not
 * among its versions: the one most readers of a multilingual corpus share.
 */
const FALLBACK_READING_LANGUAGE = "en";

/** `ENG` (an ISO 639-2 authority code) as the row language tag `en`. */
export const authenticLanguageTag = (code: string | null): string | null => {
  if (code === null || !/^[a-z]{2,3}$/iu.test(code)) {
    return null;
  }
  return normalizePublicDecisionLanguage(
    new Intl.Locale(code.toLowerCase()).language,
  );
};

type LanguageVersion = {
  language: string;
  languageGroupKey: string | null;
  /** The decision's own language tag, when its source states one. */
  authenticLanguage: string | null;
};

const versionRank = ({ language, authenticLanguage }: LanguageVersion) => {
  const tag = normalizePublicDecisionLanguage(language);
  if (tag !== null && tag === authenticLanguage) {
    return 0;
  }
  return tag === FALLBACK_READING_LANGUAGE ? 1 : 2;
};

/**
 * The rows with the version to read first in each language group: the
 * decision's own language, else English, else the first one listed.
 *
 * A caller that folds a group into its first member (an exact lookup
 * answering with one version and listing the rest) otherwise answers with
 * whichever translation sorted first, which for a 24-language corpus is
 * Bulgarian. Each group's preferred version takes the position of the
 * group's first row; every other row keeps its place.
 */
export const preferredLanguageVersionsFirst = <T extends LanguageVersion>(
  rows: readonly T[],
): T[] => {
  const preferred = new Map<string, T>();
  for (const row of rows) {
    if (row.languageGroupKey === null) {
      continue;
    }
    const current = preferred.get(row.languageGroupKey);
    if (current === undefined || versionRank(row) < versionRank(current)) {
      preferred.set(row.languageGroupKey, row);
    }
  }
  const ordered = [...rows];
  const placed = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const group = row.languageGroupKey;
    if (group === null || placed.has(group)) {
      continue;
    }
    placed.add(group);
    const best = preferred.get(group);
    if (best === undefined || best === row) {
      continue;
    }
    ordered[index] = best;
    ordered[rows.indexOf(best)] = row;
  }
  return ordered;
};

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
