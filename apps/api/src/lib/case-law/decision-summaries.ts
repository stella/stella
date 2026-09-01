import { and, eq, inArray } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";

type ReadPublicDecisionSummariesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decisionIds: readonly SafeId<"caseLawDecision">[];
};

/**
 * The row-level facts of named decisions, in the shape the public list and
 * search return, so a client can merge them with search hits. Read through the
 * public gate: a decision whose source may not be redistributed is absent.
 */
export const readPublicDecisionSummaries = async ({
  caseLawDb,
  decisionIds,
}: ReadPublicDecisionSummariesOptions) => {
  if (decisionIds.length === 0) {
    return [];
  }
  const rows = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        ecli: caseLawDecisions.ecli,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        language: caseLawDecisions.language,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        createdAt: caseLawDecisions.createdAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          inArray(caseLawDecisions.id, [...decisionIds]),
          redistributableCaseLawSource,
        ),
      )
      .limit(decisionIds.length),
  );
  const languageGroupKeys = [
    ...new Set(
      rows
        .map((row) => row.languageGroupKey)
        .filter((value): value is string => value !== null),
    ),
  ];
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys,
    });

  return rows.map((row) => ({
    id: row.id,
    caseNumber: row.caseNumber,
    slug: row.slug,
    ecli: row.ecli,
    court: row.court,
    country: row.country,
    language: row.language,
    languageAlternates: alternatesByGroupKey.alternatesFor(
      row.languageGroupKey,
    ),
    decisionDate: row.decisionDate,
    decisionType: row.decisionType,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt.toISOString(),
  }));
};
