import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { FtsSearchConfig } from "@/api/handlers/case-law/fts-config";
import { buildPlainSearchTsQuery } from "@/api/lib/search/query";

type PgFtsSearchSqlRefs = {
  language: SQL;
  regconfig: SQL;
  vector: SQL;
};

type PgFtsSearchSql = {
  headlineQuery: SQL;
  predicate: SQL;
  rank: SQL;
};

type BuildPgFtsSearchSqlArgs = {
  configs: readonly FtsSearchConfig[];
  query: string;
  refs: PgFtsSearchSqlRefs;
};

export const buildPgFtsSearchSql = ({
  configs,
  query,
  refs,
}: BuildPgFtsSearchSqlArgs): PgFtsSearchSql => {
  const knownLanguages = [
    ...new Set(configs.flatMap((config) => config.languages)),
  ];

  const branches = configs.flatMap((config) => {
    const tsQuery = buildPlainSearchTsQuery(query, {
      regconfig: sql`${config.regconfig}::regconfig`,
      useUnaccent: config.useUnaccent,
    });

    return [
      {
        condition: buildConfigCondition(config, knownLanguages, refs),
        tsQuery,
      },
      {
        condition: buildStoredRegconfigCompatibilityCondition(config, refs),
        tsQuery,
      },
    ];
  });

  const fallbackQuery = buildPlainSearchTsQuery("", {});

  return {
    headlineQuery: sql`(CASE ${sql.join(
      branches.map(
        ({ condition, tsQuery }) => sql`WHEN ${condition} THEN ${tsQuery}`,
      ),
      sql` `,
    )} ELSE ${fallbackQuery} END)`,
    predicate: sql`(${sql.join(
      branches.map(
        ({ condition, tsQuery }) =>
          sql`(${condition} AND ${refs.vector} @@ ${tsQuery})`,
      ),
      sql` OR `,
    )})`,
    rank: sql`(CASE ${sql.join(
      branches.map(
        ({ condition, tsQuery }) =>
          sql`WHEN ${condition} THEN ts_rank(${refs.vector}, ${tsQuery})::float8`,
      ),
      sql` `,
    )} ELSE 0::float8 END)`,
  };
};

const buildStoredRegconfigCompatibilityCondition = (
  config: FtsSearchConfig,
  refs: PgFtsSearchSqlRefs,
): SQL => {
  if (config.languages.length === 0) {
    return sql`false`;
  }

  return sql`${refs.regconfig} = ${config.regconfig} AND (${refs.language} IS NULL OR ${refs.language} NOT IN (${sql.join(
    config.languages.map((language) => sql`${language}`),
    sql`, `,
  )}))`;
};

const buildConfigCondition = (
  config: FtsSearchConfig,
  knownLanguages: readonly string[],
  refs: PgFtsSearchSqlRefs,
): SQL => {
  const languageMatches = config.languages.length
    ? sql`${refs.language} IN (${sql.join(
        config.languages.map((language) => sql`${language}`),
        sql`, `,
      )})`
    : sql`false`;

  const defaultMatches = config.includeDefault
    ? buildDefaultLanguageCondition(knownLanguages, refs.language)
    : sql`false`;

  return sql`${refs.regconfig} = ${config.regconfig} AND (${languageMatches} OR ${defaultMatches})`;
};

const buildDefaultLanguageCondition = (
  knownLanguages: readonly string[],
  language: SQL,
): SQL => {
  if (knownLanguages.length === 0) {
    return sql`true`;
  }

  return sql`(${language} IS NULL OR ${language} NOT IN (${sql.join(
    knownLanguages.map((knownLanguage) => sql`${knownLanguage}`),
    sql`, `,
  )}))`;
};
