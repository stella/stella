import { panic } from "better-result";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawDecisionSupplements,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import {
  republishedRulingCourtPredicate,
  rulingCourtNameKeySql,
} from "@/api/lib/case-law/ruling-identity-match";
import {
  rowHoldsDocumentFor,
  supplementIsMergedFor,
} from "@/api/lib/case-law/stored-payload";
import type { CensusListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

export const CENSUS_IDENTITY_BATCH_SIZE = 500;

type ReadStoredListingIdentitiesOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  identities: readonly CensusListingIdentity[];
};

type StoredListingDecision = { id: string; withText: boolean };

/**
 * One listed identity's stored matches. A document entry claims its decisions
 * outright; a case-number entry only names candidates, because the same row
 * may be claimed by a document entry anywhere in the listing.
 */
type StoredListingIdentity = {
  key: string;
  kind: "document" | "case-number";
  evidence: "verified" | "unmeasured";
  decisions: StoredListingDecision[];
};

/** Resolve publisher ownership and current folded supplements within the source. */
export const readStoredListingIdentities = async ({
  tx,
  sourceId,
  identities,
}: ReadStoredListingIdentitiesOptions): Promise<StoredListingIdentity[]> => {
  if (identities.length > CENSUS_IDENTITY_BATCH_SIZE) {
    panic("Census identity batch exceeds its bound");
  }
  const judgment = alias(caseLawDecisions, "census_supplement_judgment");
  const merged = and(
    supplementIsMergedFor(caseLawDecisionSupplements),
    isNotNull(judgment.id),
  );
  const incoming = identities.map((identity) => {
    const court = identity.censusCourtEvidence;
    return {
      key: listingIdentityKey(identity),
      documentId:
        identity.type === "document" ? identity.sourceDocumentId : null,
      caseNumber: identity.type === "case-number" ? identity.caseNumber : null,
      language: identity.type === "case-number" ? identity.language : null,
      court: court?.type === "known" ? court.court : null,
      courtId: court?.type === "known" ? court.courtId : null,
      courtKnown: court?.type === "known" && court.court.trim().length > 0,
    };
  });
  const normalizedKey = sql`jsonb_build_array(listed.key,
    CASE WHEN listed."documentId" IS NOT NULL OR NOT listed."courtKnown" THEN NULL
      WHEN listed."courtId" IS NOT NULL THEN 'id:' || listed."courtId"
      ELSE 'name:' || ${rulingCourtNameKeySql(sql`listed.court`)} END)::text`;
  const normalizedKind = sql`CASE WHEN listed."documentId" IS NOT NULL THEN 'document' ELSE 'case-number' END`;
  const normalizedEvidence = sql`CASE WHEN listed."documentId" IS NOT NULL OR listed."courtKnown" THEN 'verified' ELSE 'unmeasured' END`;
  // Normalize each of at most 500 publisher entries once, before any corpus joins multiply rows.
  const incomingRows = sql`(WITH normalized_census AS MATERIALIZED (
    SELECT ${normalizedKey} AS key, ${normalizedKind} AS kind, ${normalizedEvidence} AS evidence,
      listed."documentId", listed."caseNumber", listed.language, listed.court, listed."courtId", listed."courtKnown"
    FROM jsonb_to_recordset(${JSON.stringify(incoming)}::text::jsonb)
      AS listed(key text, "documentId" text, "caseNumber" text, language text, court text, "courtId" text, "courtKnown" boolean)
  ) SELECT * FROM normalized_census) AS incoming`;
  const key = sql<string>`incoming.key`;
  const kind = sql<"document" | "case-number">`incoming.kind`;
  const evidence = sql<"verified" | "unmeasured">`incoming.evidence`;
  // A case-number entry may name a decision whose detail later stored a
  // publisher document id, so it matches regardless of that id.
  return await tx
    .select({
      key,
      kind,
      evidence,
      decisions: sql<StoredListingDecision[]>`(
        coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', ${caseLawDecisions.id}, 'withText', ${rowHoldsDocumentFor(caseLawDecisions)})) FILTER (WHERE ${caseLawDecisions.id} IS NOT NULL), '[]'::jsonb)
        || coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', ${judgment.id}, 'withText', ${rowHoldsDocumentFor(judgment)})) FILTER (WHERE ${merged}), '[]'::jsonb)
      )`,
    })
    .from(incomingRows)
    .leftJoin(
      caseLawDecisionSourceIdentities,
      and(
        eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
        sql`${caseLawDecisionSourceIdentities.sourceDocumentId} = incoming."documentId"`,
      ),
    )
    .leftJoin(
      caseLawDecisions,
      and(
        eq(caseLawDecisions.sourceId, sourceId),
        or(
          eq(
            caseLawDecisions.id,
            canonicalDecisionIdSql(caseLawDecisionSourceIdentities.decisionId),
          ),
          sql`(${caseLawDecisions.sourceDocumentId} = incoming."documentId" OR
            (incoming."courtKnown" AND ${caseLawDecisions.caseNumber} = incoming."caseNumber" AND ${caseLawDecisions.language} = incoming.language
              AND ${republishedRulingCourtPredicate({ court: sql`incoming.court`, courtId: sql`incoming."courtId"` }, { court: caseLawDecisions.court, courtId: caseLawDecisions.courtId })}))`,
        ),
      ),
    )
    .leftJoin(
      caseLawDecisionSupplements,
      and(
        eq(caseLawDecisionSupplements.sourceId, sourceId),
        sql`${caseLawDecisionSupplements.sourceDocumentId} = incoming."documentId"`,
      ),
    )
    .leftJoin(
      judgment,
      and(
        eq(judgment.id, caseLawDecisionSupplements.decisionId),
        eq(judgment.sourceId, sourceId),
      ),
    )
    .groupBy(sql`incoming.key`, sql`incoming.kind`, sql`incoming.evidence`)
    .limit(identities.length);
};
