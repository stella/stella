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
  rowHoldsDocument,
  rowHoldsDocumentFor,
  supplementIsMergedFor,
} from "@/api/lib/case-law/stored-payload";
import type { ListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

type ReadStoredListingIdentitiesOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  identities: readonly ListingIdentity[];
};

/** Resolve publisher ownership and current folded supplements within the source. */
export const readStoredListingIdentities = async ({
  tx,
  sourceId,
  identities,
}: ReadStoredListingIdentitiesOptions) => {
  const judgment = alias(caseLawDecisions, "census_supplement_judgment");
  const merged = and(
    supplementIsMergedFor(caseLawDecisionSupplements),
    isNotNull(judgment.id),
  );
  const incoming = identities.map((identity) => ({
    key: listingIdentityKey(identity),
    documentId: identity.type === "document" ? identity.sourceDocumentId : null,
    caseNumber: identity.type === "case-number" ? identity.caseNumber : null,
    language: identity.type === "case-number" ? identity.language : null,
  }));
  return await tx
    .select({
      key: sql<string>`incoming.key`,
      withText: sql<boolean>`bool_or((${caseLawDecisions.id} is not null and ${rowHoldsDocument}) or (${merged} and ${rowHoldsDocumentFor(judgment)}))`,
    })
    .from(
      sql`jsonb_to_recordset(${JSON.stringify(incoming)}::text::jsonb) AS incoming(key text, "documentId" text, "caseNumber" text, language text)`,
    )
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
          sql`(${caseLawDecisions.sourceDocumentId} = incoming."documentId" OR (${caseLawDecisions.sourceDocumentId} IS NULL AND ${caseLawDecisions.caseNumber} = incoming."caseNumber" AND ${caseLawDecisions.language} = incoming.language))`,
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
    .where(or(isNotNull(caseLawDecisions.id), merged))
    .groupBy(sql`incoming.key`)
    .limit(identities.length);
};
