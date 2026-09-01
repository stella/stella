import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

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
 * The versions of a page of decisions, by language group. A decision with one
 * language, or none in the corpus, offers nothing to choose from: that is the
 * domain's empty state, not a missing invariant.
 */
export type PublicDecisionLanguageAlternatesByGroup = {
  alternatesFor: (
    languageGroupKey: string | null,
  ) => readonly PublicDecisionLanguageAlternate[];
};

const NO_ALTERNATES: readonly PublicDecisionLanguageAlternate[] = [];

/** The same lower-case, hyphenated form the public routes use for a language. */
const normalizedLanguageSql = sql<string>`replace(lower(${caseLawDecisions.language}), '_', '-')`;
const ROUTE_LANGUAGE_PATTERN = "^[a-z]{2,3}(-[a-z0-9]{2,8})*$";

/**
 * Every redistributable language version in the given groups: one row per
 * route-safe normalized language, at most
 * `caseLawLanguageAlternatesPerGroupMax` per group. Both bounds are applied
 * per group in the database, so a malformed or over-merged key can neither
 * make this public read unbounded nor starve the other groups on the page.
 */
export const readPublicDecisionLanguageAlternatesQuery =
  definePublicLawSharedQuery(
    PUBLIC_LAW_SHARED_QUERY.caseLawLanguageAlternates,
    async (
      tx: CaseLawPublicReadTransaction,
      languageGroupKeys: readonly string[],
    ): Promise<PublicDecisionLanguageAlternateRow[]> => {
      const versions = tx
        .select({
          id: caseLawDecisions.id,
          caseNumber: caseLawDecisions.caseNumber,
          slug: caseLawDecisions.slug,
          country: caseLawDecisions.country,
          court: caseLawDecisions.court,
          decisionDate: caseLawDecisions.decisionDate,
          language: caseLawDecisions.language,
          languageGroupKey: caseLawDecisions.languageGroupKey,
          languageRank: sql<number>`row_number() over (
            partition by ${caseLawDecisions.languageGroupKey}, ${normalizedLanguageSql}
            order by ${caseLawDecisions.id}
          )`.as("language_rank"),
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
            sql`${normalizedLanguageSql} ~ ${ROUTE_LANGUAGE_PATTERN}`,
          ),
        )
        .as("versions");
      const capped = tx
        .select({
          id: versions.id,
          caseNumber: versions.caseNumber,
          slug: versions.slug,
          country: versions.country,
          court: versions.court,
          decisionDate: versions.decisionDate,
          language: versions.language,
          languageGroupKey: versions.languageGroupKey,
          groupRank: sql<number>`row_number() over (
            partition by ${versions.languageGroupKey}
            order by ${versions.language}, ${versions.id}
          )`.as("group_rank"),
        })
        .from(versions)
        .where(eq(versions.languageRank, 1))
        .as("capped");
      return await tx
        .select({
          id: capped.id,
          caseNumber: capped.caseNumber,
          slug: capped.slug,
          country: capped.country,
          court: capped.court,
          decisionDate: capped.decisionDate,
          language: capped.language,
          languageGroupKey: capped.languageGroupKey,
        })
        .from(capped)
        .where(
          lte(capped.groupRank, LIMITS.caseLawLanguageAlternatesPerGroupMax),
        )
        .orderBy(
          asc(capped.languageGroupKey),
          asc(capped.language),
          asc(capped.id),
        )
        // Exactly the per-group ceilings summed; states the bound the window
        // filter above already guarantees.
        .limit(
          languageGroupKeys.length *
            LIMITS.caseLawLanguageAlternatesPerGroupMax,
        );
    },
  );

/**
 * Group the query's rows by language group. The query already yields one
 * version per route-safe language; a group with a single version is not a
 * multilingual decision and offers no alternates.
 */
export const groupPublicDecisionLanguageAlternates = (
  rows: readonly PublicDecisionLanguageAlternateRow[],
): PublicDecisionLanguageAlternatesByGroup => {
  const groups = new Map<string, PublicDecisionLanguageAlternate[]>();

  for (const { languageGroupKey, ...alternate } of rows) {
    if (
      languageGroupKey === null ||
      normalizePublicDecisionLanguage(alternate.language) === null
    ) {
      continue;
    }
    let group = groups.get(languageGroupKey);
    if (group === undefined) {
      group = [];
      groups.set(languageGroupKey, group);
    }
    group.push(alternate);
  }

  return {
    alternatesFor: (languageGroupKey) => {
      if (languageGroupKey === null) {
        return NO_ALTERNATES;
      }
      const group = groups.get(languageGroupKey);
      return group === undefined || group.length < 2 ? NO_ALTERNATES : group;
    },
  };
};

type ReadPublicDecisionLanguageAlternatesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  languageGroupKeys: readonly string[];
};

/** Alternates for a page of hits, keyed by language group. */
export const readPublicDecisionLanguageAlternatesByGroup = async ({
  caseLawDb,
  languageGroupKeys,
}: ReadPublicDecisionLanguageAlternatesOptions): Promise<PublicDecisionLanguageAlternatesByGroup> => {
  if (languageGroupKeys.length === 0) {
    return groupPublicDecisionLanguageAlternates([]);
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
}): Promise<readonly PublicDecisionLanguageAlternate[]> => {
  if (languageGroupKey === null) {
    return NO_ALTERNATES;
  }
  const rows = await readPublicDecisionLanguageAlternatesQuery(tx, [
    languageGroupKey,
  ]);
  return groupPublicDecisionLanguageAlternates(rows).alternatesFor(
    languageGroupKey,
  );
};
