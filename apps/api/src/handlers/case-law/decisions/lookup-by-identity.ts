/**
 * Resolving a published case reference to the decisions that answer to it.
 *
 * A docket, an ECLI or a reporter citation is an identity, not a query. The
 * text index ranks: it answers a docket with every decision that mentions it,
 * in an order that has nothing to do with which one *is* that docket, and a
 * bounded page of that order can leave the decision itself out. So this reads the identity columns
 * the citator resolves by and never the ranking, which also makes it
 * independent of which search provider a deployment runs: the columns are
 * there either way.
 *
 * Identity spans two tables. `case_law_decisions` holds the primary docket and
 * the ECLI; the parallel references a publisher supplies (a second docket, a
 * reporter citation) are stored only as `case_law_decision_identifiers` rows.
 * Both are read, so a reference that names a decision by either one resolves.
 *
 * `searchDecisionsHandler` has an identity branch too, reading the same id set
 * (`decisionIdsNamedBy`), but only inside the corpus-index provider and only
 * as a first attempt before it falls through to the text index. A lookup
 * cannot fall through, so it reads here.
 *
 * Both public gates apply, in one statement with the read: a decision whose
 * country is outside the public list, whose source may not be redistributed,
 * or which is listing-only, does not exist for this caller either.
 */

import { panic } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifierType,
  type DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  bareCitationKey,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import type { PublicDecisionLanguageAlternate } from "@/api/lib/case-law/language-alternates";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { LIMITS } from "@/api/lib/limits";

/**
 * What a lookup names its subject by: a docket, an ECLI, a reporter citation,
 * or a neutral citation. The kind is the caller's; a neutral citation arrives
 * only typed as one, since no free-text grammar claims it.
 */
export type DecisionIdentityLocator =
  | { kind: "docket"; value: string }
  | { kind: "ecli"; value: string }
  | { kind: "reporter"; value: string }
  | { kind: "neutral"; value: string };

/** The identifier rows each kind of reference is stored under. */
const IDENTIFIER_TYPE_OF_LOCATOR_KIND = {
  docket: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  ecli: DECISION_IDENTIFIER_TYPES.ECLI,
  neutral: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
  reporter: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
} as const satisfies Record<
  DecisionIdentityLocator["kind"],
  DecisionIdentifierType
>;

/**
 * One decision as a lookup answers it: enough to cite it and to fetch it.
 * `identifiers` carries the parallel references the publisher supplied (a
 * second docket, a reporter citation), so a caller's exact-match check can see
 * every name the decision answers to and not only its primary one.
 */
export type DecisionIdentityRow = {
  caseNumber: string;
  /** What kind of reference `caseNumber` is. */
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  decisionDate: string | null;
  ecli: string | null;
  id: SafeId<"caseLawDecision">;
  identifiers: readonly { type: DecisionIdentifierType; value: string }[];
  language: string;
  /** Every language version, which decides whether its route names one. */
  languageAlternates: readonly PublicDecisionLanguageAlternate[];
  slug: string | null;
};

type LookupDecisionsByIdentityOptions = {
  caseLawDb: CaseLawPublicReadDb;
  country: string;
  locator: DecisionIdentityLocator;
};

/**
 * Candidates read before the caller's exact-identity filter. Every predicate
 * below is key equality, but the caller compares by its own canonical key and
 * drops what merely collides under this normalization, so the listed-candidate
 * cap belongs after that filter; this read is bounded by the wider page size
 * the search handler's identity branch already reads by.
 */
const IDENTITY_CANDIDATE_SCAN_MAX = LIMITS.caseLawSearchPageSizeMax;

type IdentifierRowMatchOptions = {
  /** Whose key the column holds: the jurisdiction the reference is read in. */
  jurisdiction: string | undefined;
  tx: CaseLawPublicReadTransaction;
  type: DecisionIdentifierType;
  /** As the reference spells it; normalized here for the column. */
  value: string;
};

/**
 * The decision ids a publisher-supplied identifier row points at, normalized
 * by the function ingestion writes that column with. A set, not a correlated
 * `EXISTS`: joined to the decision's own column by `OR`, a correlated
 * subquery leaves the planner no index to drive and the read walks the
 * whole table.
 */
const identifierRowDecisionIds = ({
  jurisdiction,
  tx,
  type,
  value,
}: IdentifierRowMatchOptions) =>
  tx
    .select({ id: caseLawDecisionIdentifiers.decisionId })
    .from(caseLawDecisionIdentifiers)
    .where(
      and(
        eq(caseLawDecisionIdentifiers.type, type),
        eq(
          caseLawDecisionIdentifiers.normalizedValue,
          normalizeDecisionIdentifierValueIn(jurisdiction, type, value),
        ),
      ),
    );

/**
 * The decision's own column a kind of reference is also held in, or null for
 * a kind held only in the identifier rows. ECLIs are published in one case but
 * cited in another, and the column stores the published spelling. The
 * docket's identity is its citation key, which `bareCitationKey` already
 * normalizes: the same function that writes the column.
 */
const ownColumnCondition = (locator: DecisionIdentityLocator) => {
  switch (locator.kind) {
    case "docket":
      return eq(caseLawDecisions.citationKey, bareCitationKey(locator.value));
    case "ecli":
      return or(
        eq(caseLawDecisions.ecli, locator.value),
        eq(caseLawDecisions.ecli, locator.value.toUpperCase()),
      );
    case "neutral":
    case "reporter":
      return null;
    default: {
      locator satisfies never;
      return panic(`Unhandled decision locator: ${String(locator)}`);
    }
  }
};

/**
 * The ids of the decisions a reference names: the identifier rows of the
 * reference's type, unioned with the decision's own column where the kind has
 * one, so the outer read is a membership test that the primary key answers;
 * each side of the union has its own index. Shared by the lookup and the
 * search handler's identity branch, so the two cannot disagree about which
 * decisions a reference names.
 */
export const decisionIdsNamedBy = ({
  country,
  locator,
  tx,
}: {
  country: string | undefined;
  locator: DecisionIdentityLocator;
  tx: CaseLawPublicReadTransaction;
}) => {
  const published = identifierRowDecisionIds({
    jurisdiction: country,
    tx,
    type: IDENTIFIER_TYPE_OF_LOCATOR_KIND[locator.kind],
    value: locator.value,
  });
  const ownCondition = ownColumnCondition(locator);
  if (ownCondition === null) {
    return published;
  }
  const own = tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        country === undefined
          ? undefined
          : eq(caseLawDecisions.country, country),
        ownCondition,
      ),
    );
  return unionAll(own, published);
};

export const lookupDecisionsByIdentity = async ({
  caseLawDb,
  country,
  locator,
}: LookupDecisionsByIdentityOptions): Promise<DecisionIdentityRow[]> => {
  const rows = await caseLawDb(async (tx) => {
    const decisions = await tx
      .select({
        caseNumber: caseLawDecisions.caseNumber,
        caseNumberType: caseLawDecisions.caseNumberType,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
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
          inArray(
            caseLawDecisions.id,
            decisionIdsNamedBy({ country, locator, tx }),
          ),
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
      .limit(IDENTITY_CANDIDATE_SCAN_MAX);

    if (decisions.length === 0) {
      return [];
    }

    // The parallel references, read for exactly the decisions that answered.
    const identifierRows = await tx
      .select({
        decisionId: caseLawDecisionIdentifiers.decisionId,
        type: caseLawDecisionIdentifiers.type,
        value: caseLawDecisionIdentifiers.value,
      })
      .from(caseLawDecisionIdentifiers)
      .where(
        inArray(
          caseLawDecisionIdentifiers.decisionId,
          decisions.map((decision) => decision.id),
        ),
      );
    const identifiersByDecision = new Map<
      string,
      { type: DecisionIdentifierType; value: string }[]
    >();
    for (const decision of decisions) {
      identifiersByDecision.set(String(decision.id), []);
    }
    for (const row of identifierRows) {
      // Keyed off the decisions just read, so a row for anything else is a
      // join this statement cannot produce.
      const values =
        identifiersByDecision.get(String(row.decisionId)) ??
        panic("Read an identifier for a decision this lookup did not name");
      values.push({ type: row.type, value: row.value });
    }

    const alternates = await readPublicDecisionLanguageAlternatesInTx(
      tx,
      decisions.map((decision) => decision.languageGroupKey),
    );

    return decisions.map(
      ({ languageGroupKey, ...decision }): DecisionIdentityRow =>
        Object.assign(decision, {
          identifiers:
            identifiersByDecision.get(String(decision.id)) ??
            panic("Lost a decision's identifier list"),
          languageAlternates: alternates.alternatesFor(languageGroupKey),
        }),
    );
  });

  return rows;
};
