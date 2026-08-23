import { and, eq, inArray, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

const CASE_LAW_LANGUAGE_SEGMENT_PATTERN = "^[a-z]{2,3}(-[a-z0-9]{2,8})*$";

const normalizedCaseLawLanguageSql = sql<string>`replace(lower(${caseLawDecisions.language}), '_', '-')`;

const validCaseLawLanguageAlternateCountSql = sql<number>`(
  count(distinct ${normalizedCaseLawLanguageSql})
    filter (where ${normalizedCaseLawLanguageSql} ~ ${CASE_LAW_LANGUAGE_SEGMENT_PATTERN})
)::int`;

export const readDecisionLanguageAlternateCountsQuery =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawLanguageAlternateCounts,
    async (tx: CaseLawPublicReadTransaction, languageGroupKeys: string[]) =>
      await tx
        .select({
          languageGroupKey: caseLawDecisions.languageGroupKey,
          count: validCaseLawLanguageAlternateCountSql,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            inArray(caseLawDecisions.languageGroupKey, languageGroupKeys),
            redistributableCaseLawSource,
          ),
        )
        .groupBy(caseLawDecisions.languageGroupKey),
  );

type ReadDecisionLanguageAlternateCountsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  languageGroupKeys: string[];
};

export const readDecisionLanguageAlternateCounts = async ({
  caseLawDb,
  languageGroupKeys,
}: ReadDecisionLanguageAlternateCountsOptions) =>
  await caseLawDb(
    async (tx) =>
      await readDecisionLanguageAlternateCountsQuery(tx, languageGroupKeys),
  );
