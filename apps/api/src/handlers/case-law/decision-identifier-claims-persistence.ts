import type { SQLWrapper } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawHeldDecisionAttachments,
} from "@/api/db/schema";
import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import type { SafeId } from "@/api/lib/branded-types";
import { sameStoredCaseNumberKeySql } from "@/api/lib/case-law/case-number-match-key";
import { DECISION_IDENTIFIER_CLAIM } from "@/api/lib/case-law/decision-identifier-claims";
import { replayWrite } from "@/api/lib/case-law/replay-write";

type ClaimedDecisionIdentifier = {
  type: DecisionIdentifierType;
  value: string;
  normalizedValue: string;
};

// Old undeclared rows were derived by the host. Old declarations may have
// several owners, so their unverified claim must survive a withdrawal.
const knownIndependentClaims = sql`CASE
  WHEN ${caseLawDecisionIdentifiers.declaredAt} IS NULL
    AND ${caseLawDecisionIdentifiers.independentClaims} = ARRAY[${DECISION_IDENTIFIER_CLAIM.UNVERIFIED}]::varchar[]
  THEN ARRAY[${DECISION_IDENTIFIER_CLAIM.HOST}]::varchar[]
  ELSE ${caseLawDecisionIdentifiers.independentClaims} END`;

/** The post claim uses the same exact typed identity as identifier persistence. */
export const activeAttachmentIdentifierClaimSql = ({
  decisionId,
  type,
  normalizedValue,
}: {
  decisionId: SQLWrapper;
  type: SQLWrapper;
  normalizedValue: SQLWrapper;
}) => sql`EXISTS (
  SELECT 1 FROM ${caseLawHeldDecisionAttachments} attachment
  WHERE attachment.host_decision_id = ${decisionId}
    AND attachment.host_withdrawn_at IS NULL
    AND attachment.declared_identifiers @> jsonb_build_array(jsonb_build_object(
      'type', ${type}, 'normalizedValue', ${normalizedValue})))`;

const hasAttachmentClaim = activeAttachmentIdentifierClaimSql({
  decisionId: caseLawDecisionIdentifiers.decisionId,
  type: caseLawDecisionIdentifiers.type,
  normalizedValue: caseLawDecisionIdentifiers.normalizedValue,
});

const incomingIdentifier = (
  identifiers: readonly ClaimedDecisionIdentifier[],
) => sql`EXISTS (
  SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(identifiers)}::text::jsonb)
    AS incoming(type text, "normalizedValue" text)
  WHERE incoming.type = ${caseLawDecisionIdentifiers.type}
    AND ${sameStoredCaseNumberKeySql(sql`incoming."normalizedValue"`, caseLawDecisionIdentifiers.normalizedValue)})`;

type RefreshHostIdentifierOptions = {
  decisionId: SafeId<"caseLawDecision">;
  identifiers: readonly ClaimedDecisionIdentifier[];
};

type ReconcileHostIdentifierClaimsOptions = {
  decisionIds: readonly SafeId<"caseLawDecision">[];
  identifiers: readonly (ClaimedDecisionIdentifier & {
    decisionId: SafeId<"caseLawDecision">;
  })[];
};

/** One bounded bulk claim update serves live refresh and stored-identifier projection. */
export const reconcileHostIdentifierClaimsTx = async (
  tx: CitationGraphTransaction<Transaction>,
  { decisionIds, identifiers }: ReconcileHostIdentifierClaimsOptions,
): Promise<void> => {
  if (decisionIds.length === 0) {
    return;
  }
  const hostClaim = DECISION_IDENTIFIER_CLAIM.HOST;
  const observed = sql`EXISTS (
    SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(identifiers)}::text::jsonb)
      AS incoming("decisionId" uuid, type text, "normalizedValue" text)
    WHERE incoming."decisionId" = ${caseLawDecisionIdentifiers.decisionId}
      AND incoming.type = ${caseLawDecisionIdentifiers.type}
      AND ${sameStoredCaseNumberKeySql(sql`incoming."normalizedValue"`, caseLawDecisionIdentifiers.normalizedValue)})`;
  const desiredClaims = sql`CASE WHEN ${observed} THEN
      CASE WHEN ${knownIndependentClaims} @> ARRAY[${hostClaim}]::varchar[]
        THEN ${knownIndependentClaims} ELSE array_append(${knownIndependentClaims}, ${hostClaim}) END
    ELSE array_remove(${knownIndependentClaims}, ${hostClaim}) END`;
  const claims = replayWrite(caseLawDecisionIdentifiers, {
    independentClaims: desiredClaims,
  });
  // audit: skip — canonical public decision identifier ownership
  await tx
    .update(caseLawDecisionIdentifiers)
    .set(claims.set)
    .where(
      and(
        sql`${caseLawDecisionIdentifiers.decisionId} IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(decisionIds)}::text::jsonb))`,
        claims.setWhere,
      ),
    );
};

/** Replace only the host's independent claim, preserving aliases and publisher posts. */
export const refreshHostDecisionIdentifiersTx = async (
  tx: CitationGraphTransaction<Transaction>,
  { decisionId, identifiers }: RefreshHostIdentifierOptions,
): Promise<void> => {
  const hostClaim = DECISION_IDENTIFIER_CLAIM.HOST;
  await reconcileHostIdentifierClaimsTx(tx, {
    decisionIds: [decisionId],
    identifiers: identifiers.map((identifier) => ({
      decisionId,
      ...identifier,
    })),
  });
  // audit: skip — remove only identifiers that have no independent or attached owner
  await tx
    .delete(caseLawDecisionIdentifiers)
    .where(
      and(
        eq(caseLawDecisionIdentifiers.decisionId, decisionId),
        sql`cardinality(${caseLawDecisionIdentifiers.independentClaims}) = 0`,
        sql`NOT ${hasAttachmentClaim}`,
      ),
    );
  if (identifiers.length === 0) {
    return;
  }
  const spelling = replayWrite(caseLawDecisionIdentifiers, {
    value: sql`excluded.value`,
  });
  // audit: skip — canonical public decision identifier ownership
  await tx
    .insert(caseLawDecisionIdentifiers)
    .values(
      identifiers.map((identifier) => ({
        decisionId,
        ...identifier,
        independentClaims: [hostClaim],
      })),
    )
    .onConflictDoUpdate({
      target: [
        caseLawDecisionIdentifiers.decisionId,
        caseLawDecisionIdentifiers.type,
        caseLawDecisionIdentifiers.normalizedValue,
      ],
      set: spelling.set,
      setWhere: spelling.setWhere,
    });
};

type DeclareDecisionIdentifierOptions = RefreshHostIdentifierOptions & {
  claim:
    | { type: "attachment"; observedAt: Date }
    | { type: "retired-alias"; observedAt: Date };
};

/** Declaration producers retain their claim without replacing any existing support. */
export const declareDecisionIdentifiersTx = async (
  tx: CitationGraphTransaction<Transaction>,
  { decisionId, identifiers, claim }: DeclareDecisionIdentifierOptions,
): Promise<void> => {
  if (identifiers.length === 0) {
    return;
  }
  const independentClaims =
    claim.type === "attachment"
      ? knownIndependentClaims
      : sql`CASE WHEN ${knownIndependentClaims} @> ARRAY[${DECISION_IDENTIFIER_CLAIM.RETIRED_ALIAS}]::varchar[]
      THEN ${knownIndependentClaims}
      ELSE array_append(${knownIndependentClaims}, ${DECISION_IDENTIFIER_CLAIM.RETIRED_ALIAS}) END`;
  const declaration = replayWrite(caseLawDecisionIdentifiers, {
    declaredAt: sql`coalesce(${caseLawDecisionIdentifiers.declaredAt}, excluded.declared_at)`,
    independentClaims,
  });
  // audit: skip — source-attributed declarations on a canonical public decision
  await tx
    .insert(caseLawDecisionIdentifiers)
    .values(
      identifiers.map((identifier) => ({
        decisionId,
        ...identifier,
        declaredAt: claim.observedAt,
        independentClaims:
          claim.type === "attachment"
            ? []
            : [DECISION_IDENTIFIER_CLAIM.RETIRED_ALIAS],
      })),
    )
    .onConflictDoUpdate({
      target: [
        caseLawDecisionIdentifiers.decisionId,
        caseLawDecisionIdentifiers.type,
        caseLawDecisionIdentifiers.normalizedValue,
      ],
      set: declaration.set,
      setWhere: declaration.setWhere,
    });
};

/** Call after the attachment's declaration list has been updated under the host lock. */
export const withdrawAttachmentIdentifiersTx = async (
  tx: CitationGraphTransaction<Transaction>,
  { decisionId, identifiers }: RefreshHostIdentifierOptions,
): Promise<void> => {
  if (identifiers.length === 0) {
    return;
  }
  // audit: skip — remove only an identifier whose last supporting claim was withdrawn
  await tx
    .delete(caseLawDecisionIdentifiers)
    .where(
      and(
        eq(caseLawDecisionIdentifiers.decisionId, decisionId),
        incomingIdentifier(identifiers),
        sql`cardinality(${caseLawDecisionIdentifiers.independentClaims}) = 0`,
        sql`NOT ${hasAttachmentClaim}`,
      ),
    );
};
