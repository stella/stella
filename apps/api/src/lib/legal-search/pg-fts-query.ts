import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import type { FtsSearchConfig } from "@/api/lib/legal-search/fts-config";
import { buildPlainSearchTsQuery } from "@/api/lib/search/query";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

type PgFtsSearchSqlRefs = {
  language: SQL;
  regconfig: SQL;
  vector: SQL;
};

type PgFtsSearchSql = {
  coverage: SQL;
  headlineQuery: SQL;
  predicate: SQL;
  rank: SQL;
};

type BuildPgFtsSearchSqlArgs = {
  match?: "all" | "any";
  configs: readonly FtsSearchConfig[];
  query: string;
  refs: PgFtsSearchSqlRefs;
};

export const buildPgFtsSearchSql = ({
  configs,
  match = "all",
  query,
  refs,
}: BuildPgFtsSearchSqlArgs): PgFtsSearchSql => {
  const knownLanguages = [
    ...new Set(configs.flatMap((config) => config.languages)),
  ];

  const branches = configs.flatMap((config) => {
    const options = {
      regconfig: sql`${config.regconfig}::regconfig`,
      useUnaccent: config.useUnaccent,
    };
    const termQueries = [
      ...new Set(tokenizeCorpusFreeText(query).map(({ value }) => value)),
    ].map((term) => buildPlainSearchTsQuery(term, options));
    const tsQuery =
      match === "any" && termQueries.length > 0
        ? sql`(${sql.join(termQueries, sql` || `)})`
        : buildPlainSearchTsQuery(query, options);
    const coverage =
      termQueries.length === 0
        ? sql`0`
        : sql`(${sql.join(
            termQueries.map(
              (termQuery) =>
                sql`CASE WHEN ${refs.vector} @@ ${termQuery} THEN 1 ELSE 0 END`,
            ),
            sql` + `,
          )})`;

    return [
      {
        condition: buildConfigCondition(config, knownLanguages, refs),
        tsQuery,
        coverage,
      },
      {
        condition: buildStoredRegconfigCompatibilityCondition(config, refs),
        tsQuery,
        coverage,
      },
    ];
  });

  const fallbackQuery = buildPlainSearchTsQuery("", {});

  return {
    coverage: sql`(${sqlCaseFragment({
      branches: branches.map(
        ({ condition, coverage }) => sql`WHEN ${condition} THEN ${coverage}`,
      ),
      fallback: sql`0`,
    })})`,
    headlineQuery: sql`(${sqlCaseFragment({
      branches: branches.map(
        ({ condition, tsQuery }) => sql`WHEN ${condition} THEN ${tsQuery}`,
      ),
      fallback: fallbackQuery,
    })})`,
    predicate: sql`(${sql.join(
      branches.map(
        ({ condition, tsQuery }) =>
          sql`(${condition} AND ${refs.vector} @@ ${tsQuery})`,
      ),
      sql` OR `,
    )})`,
    rank: sql`(${sqlCaseFragment({
      branches: branches.map(
        ({ condition, tsQuery }) =>
          sql`WHEN ${condition} THEN ts_rank(${refs.vector}, ${tsQuery})::float8`,
      ),
      fallback: sql`0::float8`,
    })})`,
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
