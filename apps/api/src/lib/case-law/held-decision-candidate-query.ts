import { and, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { decisionDocketFamilySpellings } from "@stll/api-contract/decision-docket-reference";
import {
  isWholeEntryIdentifier,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import {
  DECISION_IDENTIFIER_TYPES,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import { ecliPublisherSpellings } from "@/api/lib/case-law/ecli-spellings";
import {
  heldDocketPredicate,
  heldDocketStrings,
} from "@/api/lib/case-law/held-decision-docket-predicate";
import { republishedRulingCourtPredicate } from "@/api/lib/case-law/ruling-identity-match";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX } from "@/api/lib/legal-search/held-decision-attachment-values";

/** A placeholder or prose containing an ECLI cannot supply a ruling identity. */
export const heldDecisionEcliIdentity = (
  country: string,
  value: string | undefined,
) => {
  if (value === undefined) {
    return null;
  }
  const spellings = ecliPublisherSpellings(country, value.trim());
  // A publisher can print accents in a docket register whose ECLI uses ASCII.
  let canonicalEcli: string | undefined;
  for (const spelling of spellings) {
    const intent = parseDecisionQuery(spelling);
    if (
      intent.type === "identifier" &&
      intent.kind === "ecli" &&
      isWholeEntryIdentifier(intent)
    ) {
      canonicalEcli = intent.value;
      break;
    }
  }
  if (canonicalEcli === undefined) {
    return null;
  }
  const primaryValues = [
    ...new Set([
      ...spellings,
      ...ecliPublisherSpellings(country, canonicalEcli),
    ]),
  ];
  const keys = [
    ...new Set(
      primaryValues.map((spelling) =>
        normalizeStructuredDecisionIdentifier({
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          value: spelling,
        }),
      ),
    ),
  ];
  return { primaryValues, keys };
};

const canonical = alias(caseLawDecisions, "held_candidate_canonical");
const publisher = alias(caseLawSources, "held_candidate_publisher");

type CandidateIdentityPath =
  | { basis: "ecli"; keys: readonly string[]; primaryValues: readonly string[] }
  | {
      basis: "court-docket-date";
      decisionDate: string;
      docketKeys: readonly string[];
      caseNumber: string;
    }
  | {
      basis: "court-docket-other-date";
      docketKeys: readonly string[];
      caseNumber: string;
    };

type HeldDecisionCandidateQueryOptions = {
  country: string;
  court: string;
  courtId: string | undefined;
  sourceId: SafeId<"caseLawSource">;
  collectionAdapterKeys: readonly string[];
  role: "host" | "collection";
  path: CandidateIdentityPath;
};

/**
 * Every identity lookup shares this candidate owner. Match indexed historical
 * rows first, then collapse approved aliases before checking the candidate cap.
 */
export const readHeldDecisionCandidates = (
  tx: Transaction,
  {
    country,
    court,
    courtId,
    sourceId,
    collectionAdapterKeys,
    role,
    path,
  }: HeldDecisionCandidateQueryOptions,
) => {
  const sourceIsCollection = or(
    eq(canonical.sourceId, sourceId),
    inArray(publisher.adapterKey, [...collectionAdapterKeys]),
  );
  const sourceIsHost = and(
    ne(canonical.sourceId, sourceId),
    notInArray(publisher.adapterKey, [...collectionAdapterKeys]),
  );
  const docket =
    path.basis === "ecli"
      ? undefined
      : and(
          republishedRulingCourtPredicate(
            {
              court: sql`${court}::text`,
              courtId: courtId === undefined ? null : sql`${courtId}::text`,
            },
            {
              court: caseLawDecisions.court,
              courtId: caseLawDecisions.courtId,
            },
          ),
          heldDocketPredicate({
            candidateKey: caseLawDecisions.docketFamilyKey,
            candidateNumber: caseLawDecisions.caseNumber,
            expectedKeys: heldDocketStrings(path.docketKeys),
            expectedSpellings: heldDocketStrings([
              ...new Set([
                path.caseNumber,
                ...decisionDocketFamilySpellings(path.caseNumber, country),
              ]),
            ]),
          }),
          path.basis === "court-docket-date"
            ? eq(caseLawDecisions.decisionDate, path.decisionDate)
            : undefined,
        );
  const identity =
    path.basis === "ecli"
      ? sql`${caseLawDecisions.id} IN (
      SELECT ${caseLawDecisionIdentifiers.decisionId} FROM ${caseLawDecisionIdentifiers}
      WHERE ${caseLawDecisionIdentifiers.type} = ${DECISION_IDENTIFIER_TYPES.ECLI}
        AND ${inArray(caseLawDecisionIdentifiers.normalizedValue, [...path.keys])}
      UNION
      SELECT primary_ecli.id FROM ${caseLawDecisions} primary_ecli
      WHERE primary_ecli.ecli IS NOT NULL
        AND ${inArray(
          sql`upper(primary_ecli.ecli)`,
          path.primaryValues.map((value) => value.toLocaleUpperCase("und")),
        )})`
      : docket;
  return readBounded(
    tx
      .selectDistinct({
        id: canonical.id,
        sourceId: canonical.sourceId,
        redactedAt: canonical.redactedAt,
        ecli: canonical.ecli,
        adapterKey: publisher.adapterKey,
      })
      .from(caseLawDecisions)
      .innerJoin(
        canonical,
        eq(canonical.id, canonicalDecisionIdSql(caseLawDecisions.id)),
      )
      .innerJoin(publisher, eq(publisher.id, canonical.sourceId))
      .where(
        and(
          eq(caseLawDecisions.country, country),
          eq(canonical.country, country),
          role === "host" ? sourceIsHost : sourceIsCollection,
          identity,
        ),
      )
      .orderBy(canonical.id),
    HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX,
  );
};
