import { and, asc, eq, inArray } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { normalizePublicDecisionLanguage } from "@/api/lib/case-law/decision-language";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { LIMITS } from "@/api/lib/limits";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * One language version of a decision, with everything its own public route
 * needs. Court and slug are per version: a judgment's court name is stored in
 * each language, and each version carries its own slug.
 */
export type PublicDecisionLanguageAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  id: string;
  language: string;
  slug: string | null;
};

type PublicDecisionLanguageAlternateRow = PublicDecisionLanguageAlternate & {
  languageGroupKey: string | null;
};

/**
 * Every redistributable language version in the given groups, ordered so that
 * grouping below is deterministic. Bounded per requested group: a
 * malformed or over-merged key cannot make this public read unbounded.
 */
export const readPublicDecisionLanguageAlternatesQuery =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawLanguageAlternates,
    async (
      tx: CaseLawPublicReadTransaction,
      languageGroupKeys: readonly string[],
    ): Promise<PublicDecisionLanguageAlternateRow[]> =>
      await tx
        .select({
          id: caseLawDecisions.id,
          caseNumber: caseLawDecisions.caseNumber,
          slug: caseLawDecisions.slug,
          country: caseLawDecisions.country,
          court: caseLawDecisions.court,
          decisionDate: caseLawDecisions.decisionDate,
          language: caseLawDecisions.language,
          languageGroupKey: caseLawDecisions.languageGroupKey,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            inArray(caseLawDecisions.languageGroupKey, [...languageGroupKeys]),
            redistributableCaseLawSource,
          ),
        )
        .orderBy(
          asc(caseLawDecisions.languageGroupKey),
          asc(caseLawDecisions.language),
          asc(caseLawDecisions.id),
        )
        .limit(
          languageGroupKeys.length *
            LIMITS.caseLawLanguageAlternatesPerGroupMax,
        ),
  );

/**
 * Group rows by language group, one version per normalized language, capped
 * per group. A group with a single language is not a multilingual decision
 * and is left out, so callers can read "present" as "there is a choice".
 */
export const groupPublicDecisionLanguageAlternates = (
  rows: readonly PublicDecisionLanguageAlternateRow[],
): Map<string, PublicDecisionLanguageAlternate[]> => {
  const seenLanguagesByGroup = new Map<string, Set<string>>();
  const alternatesByGroup = new Map<
    string,
    PublicDecisionLanguageAlternate[]
  >();

  for (const { languageGroupKey, ...alternate } of rows) {
    if (languageGroupKey === null) {
      continue;
    }
    const language = normalizePublicDecisionLanguage(alternate.language);
    if (language === null) {
      continue;
    }
    const seenLanguages =
      seenLanguagesByGroup.get(languageGroupKey) ?? new Set<string>();
    if (
      seenLanguages.has(language) ||
      seenLanguages.size >= LIMITS.caseLawLanguageAlternatesPerGroupMax
    ) {
      continue;
    }
    seenLanguages.add(language);
    seenLanguagesByGroup.set(languageGroupKey, seenLanguages);
    const alternates = alternatesByGroup.get(languageGroupKey) ?? [];
    alternates.push(alternate);
    alternatesByGroup.set(languageGroupKey, alternates);
  }

  for (const [languageGroupKey, alternates] of alternatesByGroup) {
    if (alternates.length < 2) {
      alternatesByGroup.delete(languageGroupKey);
    }
  }

  return alternatesByGroup;
};

type ReadPublicDecisionLanguageAlternatesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  languageGroupKeys: readonly string[];
};

/** Alternates for a page of hits, keyed by language group. */
export const readPublicDecisionLanguageAlternatesByGroup = async ({
  caseLawDb,
  languageGroupKeys,
}: ReadPublicDecisionLanguageAlternatesOptions): Promise<
  Map<string, PublicDecisionLanguageAlternate[]>
> => {
  if (languageGroupKeys.length === 0) {
    return new Map();
  }
  const rows = await caseLawDb(
    async (tx) =>
      await readPublicDecisionLanguageAlternatesQuery(tx, languageGroupKeys),
  );
  return groupPublicDecisionLanguageAlternates(rows);
};

/** The language versions of one decision; empty unless there is a choice. */
export const listPublicDecisionLanguageAlternates = async ({
  tx,
  languageGroupKey,
}: {
  tx: CaseLawPublicReadTransaction;
  languageGroupKey: string | null;
}): Promise<PublicDecisionLanguageAlternate[]> => {
  if (languageGroupKey === null) {
    return [];
  }
  const rows = await readPublicDecisionLanguageAlternatesQuery(tx, [
    languageGroupKey,
  ]);
  return (
    groupPublicDecisionLanguageAlternates(rows).get(languageGroupKey) ?? []
  );
};
