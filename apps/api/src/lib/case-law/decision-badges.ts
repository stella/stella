import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import type { CaseLawDecisionLanguageAlternate } from "@stll/api-contract/case-law-decision-route";
import { isPublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import type { CourtWeightMap } from "@/api/lib/case-law/court-weights";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * A decision as a compact reference draws it elsewhere in the product: the
 * court chip, the case number and the date, plus what a client needs to open
 * the decision itself.
 */
export type PublicDecisionBadge = {
  caseNumber: string;
  country: string;
  court: string;
  courtAbbreviation: string | null;
  courtTier: CourtTierLabel;
  decisionDate: string | null;
  id: SafeId<"caseLawDecision">;
  language: string | null;
  languageAlternates: readonly CaseLawDecisionLanguageAlternate[];
  slug: string | null;
};

type ReadPublicDecisionBadgesOptions = {
  caseLawDb?: CaseLawPublicReadDb;
  decisionIds: readonly SafeId<"caseLawDecision">[];
  /** The court registry the chip is drawn from; a harness supplies its own. */
  readCourtWeights?: () => Promise<CourtWeightMap>;
};

/**
 * The badges of named decisions, keyed by id, in one read.
 *
 * Read through the public gate: a decision that is no longer published,
 * redistributable or in a public country is absent from the map, exactly as
 * the reader would answer "not found" for it. A failed read is an error, not
 * an empty map, so a caller can tell "nothing to draw" from "could not tell".
 * The court registry degrades on its own: without it a badge has no chip.
 */
export const readPublicDecisionBadges = async ({
  caseLawDb = caseLawPublicReadDb,
  decisionIds,
  readCourtWeights = loadPublicCourtWeights,
}: ReadPublicDecisionBadgesOptions): Promise<
  Result<
    ReadonlyMap<SafeId<"caseLawDecision">, PublicDecisionBadge>,
    HandlerError<500>
  >
> => {
  const uniqueIds = [...new Set(decisionIds)];
  if (uniqueIds.length === 0) {
    return Result.ok(new Map());
  }
  return await Result.tryPromise({
    try: async () => {
      const [rows, courtWeights] = await Promise.all([
        caseLawDb((tx) =>
          tx
            .select({
              caseNumber: caseLawDecisions.caseNumber,
              country: caseLawDecisions.country,
              court: caseLawDecisions.court,
              courtId: caseLawDecisions.courtId,
              decisionDate: caseLawDecisions.decisionDate,
              ecli: caseLawDecisions.ecli,
              id: caseLawDecisions.id,
              language: caseLawDecisions.language,
              languageGroupKey: caseLawDecisions.languageGroupKey,
              slug: caseLawDecisions.slug,
            })
            .from(caseLawDecisions)
            .innerJoin(
              caseLawSources,
              eq(caseLawSources.id, caseLawDecisions.sourceId),
            )
            .where(
              and(
                inArray(caseLawDecisions.id, uniqueIds),
                redistributableCaseLawSource,
                publishedCaseLawDecision,
              ),
            )
            .limit(uniqueIds.length),
        ),
        readCourtRegistry(readCourtWeights),
      ]);
      const publicRows = rows.filter((row) =>
        isPublicCaseLawCountry(row.country),
      );
      const alternatesByGroupKey =
        await readPublicDecisionLanguageAlternatesByGroup({
          caseLawDb,
          languageGroupKeys: [
            ...new Set(
              publicRows
                .map((row) => row.languageGroupKey)
                .filter((value): value is string => value !== null),
            ),
          ],
        });
      return new Map(
        publicRows.map((row) => {
          const presentation = courtPresentation(courtWeights, row);
          return [
            row.id,
            {
              caseNumber: row.caseNumber,
              country: row.country,
              court: row.court,
              courtAbbreviation: presentation.courtAbbreviation,
              courtTier: presentation.courtTier,
              decisionDate: row.decisionDate,
              id: row.id,
              language: row.language,
              // Only what opening the decision needs: which languages it
              // reads in, not a page of alternate rows per badge.
              languageAlternates: alternatesByGroupKey
                .alternatesFor(row.languageGroupKey)
                .map(({ language }) => ({ language })),
              slug: row.slug,
            },
          ] as const;
        }),
      );
    },
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Reading decision badges failed",
        cause,
      }),
  });
};
