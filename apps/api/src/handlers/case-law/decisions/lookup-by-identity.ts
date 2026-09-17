/**
 * Resolving a published case reference to the decisions that answer to it.
 *
 * A docket or an ECLI is an identity, not a query. The text index ranks: it
 * answers a docket with every decision that mentions it, in an order that has
 * nothing to do with which one *is* that docket, and a bounded page of that
 * order can leave the decision itself out. So this reads the identity columns
 * the citator resolves by and never the ranking, which also makes it
 * independent of which search provider a deployment runs: the columns are
 * there either way.
 *
 * `searchDecisionsHandler` has an identity branch of its own, but only inside
 * the corpus-index provider and only as a first attempt before it falls
 * through to the text index. A lookup cannot fall through, so it reads here.
 *
 * Both public gates apply, in one statement with the read: a decision whose
 * country is outside the public list, whose source may not be redistributed,
 * or which is listing-only, does not exist for this caller either.
 */

import { panic } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { LIMITS } from "@/api/lib/limits";

/** What a lookup names its subject by. */
export type DecisionIdentityLocator =
  | { kind: "docket"; value: string }
  | { kind: "ecli"; value: string };

/**
 * One decision as a lookup answers it: enough to cite it and to fetch it.
 * `identifiers` carries the parallel references the publisher supplied (a
 * second docket, a reporter citation), so a caller's exact-match check can see
 * every name the decision answers to and not only its primary one.
 */
export type DecisionIdentityRow = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  ecli: string | null;
  id: SafeId<"caseLawDecision">;
  identifiers: readonly { value: string }[];
  language: string;
  slug: string | null;
};

type LookupDecisionsByIdentityOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  /** Candidates to read; past this the reference names a list, not a decision. */
  limit?: number;
  locator: DecisionIdentityLocator;
};

/**
 * ECLIs are published in one case but cited in another, and the column stores
 * the published spelling. The docket's identity is its citation key, which
 * `bareCitationKey` already normalizes.
 */
const identityCondition = (locator: DecisionIdentityLocator) => {
  if (locator.kind === "ecli") {
    return or(
      eq(caseLawDecisions.ecli, locator.value),
      eq(caseLawDecisions.ecli, locator.value.toUpperCase()),
    );
  }
  return eq(caseLawDecisions.citationKey, bareCitationKey(locator.value));
};

export const lookupDecisionsByIdentity = async ({
  caseLawDb,
  country,
  limit = LIMITS.caseLawLookupCandidatesMax + 1,
  locator,
}: LookupDecisionsByIdentityOptions): Promise<DecisionIdentityRow[]> => {
  const rows = await caseLawDb(async (tx) => {
    const decisions = await tx
      .select({
        caseNumber: caseLawDecisions.caseNumber,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
        decisionDate: caseLawDecisions.decisionDate,
        ecli: caseLawDecisions.ecli,
        id: caseLawDecisions.id,
        language: caseLawDecisions.language,
        slug: caseLawDecisions.slug,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          identityCondition(locator),
          eq(caseLawDecisions.country, country),
          publishedCaseLawDecision,
          redistributableCaseLawSourceFor(caseLawSources.descriptor),
        ),
      )
      // Court, then date, then id: the candidates a caller has to choose
      // between come back in the same order twice, and in the order the choice
      // is actually made in.
      .orderBy(
        caseLawDecisions.court,
        caseLawDecisions.decisionDate,
        caseLawDecisions.id,
      )
      .limit(limit);

    if (decisions.length === 0) {
      return [];
    }

    // The parallel references, read for exactly the decisions that answered.
    const identifierRows = await tx
      .select({
        decisionId: caseLawDecisionIdentifiers.decisionId,
        value: caseLawDecisionIdentifiers.value,
      })
      .from(caseLawDecisionIdentifiers)
      .where(
        inArray(
          caseLawDecisionIdentifiers.decisionId,
          decisions.map((decision) => decision.id),
        ),
      );
    const identifiersByDecision = new Map<string, { value: string }[]>();
    for (const decision of decisions) {
      identifiersByDecision.set(String(decision.id), []);
    }
    for (const row of identifierRows) {
      // Keyed off the decisions just read, so a row for anything else is a
      // join this statement cannot produce.
      const values =
        identifiersByDecision.get(String(row.decisionId)) ??
        panic("Read an identifier for a decision this lookup did not name");
      values.push({ value: row.value });
    }

    return decisions.map((decision) =>
      Object.assign(decision, {
        identifiers:
          identifiersByDecision.get(String(decision.id)) ??
          panic("Lost a decision's identifier list"),
      }),
    );
  });

  return rows;
};
