/**
 * The facts a verification is checked against, read from a list at the
 * moment the run starts and pinned on the run by value.
 *
 * Held facts are left out: `held` means a reviewer has not yet confirmed the
 * fact can be relied on. A rejected source is left off its fact, since it no
 * longer says where the fact comes from.
 */

import { and, asc, eq, inArray, ne, or, isNull } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListFactDetails,
  legalListItemSources,
  legalListItems,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type {
  VerificationEvidence,
  VerificationEvidenceFact,
  VerificationEvidenceSource,
} from "@/api/lib/lists/verification/contract";

type ReadEvidenceArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
};

export type ReadEvidenceOutcome =
  | { type: "read"; evidence: VerificationEvidence }
  | { type: "too-many-facts"; count: number };

export const readVerificationEvidence = async ({
  tx,
  workspaceId,
  listId,
}: ReadEvidenceArgs): Promise<ReadEvidenceOutcome> => {
  // One more than the cap, so an oversized list is reported, not truncated.
  const facts = await tx
    .select({
      factEntityId: legalListItems.entityId,
      text: entities.name,
      occurredOn: legalListFactDetails.occurredOn,
      occurredOnPrecision: legalListFactDetails.occurredOnPrecision,
      evidenceKind: legalListFactDetails.evidenceKind,
      medium: legalListFactDetails.medium,
      confidence: legalListFactDetails.confidence,
      interpretationNote: legalListFactDetails.interpretationNote,
    })
    .from(legalListItems)
    .innerJoin(
      entities,
      and(
        eq(entities.id, legalListItems.entityId),
        eq(entities.workspaceId, legalListItems.workspaceId),
      ),
    )
    .leftJoin(
      legalListFactDetails,
      eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
    )
    .where(
      and(
        eq(legalListItems.workspaceId, workspaceId),
        eq(legalListItems.listId, listId),
        eq(entities.listItemType, LIST_ITEM_TYPE.FACT),
        or(
          isNull(legalListFactDetails.scoring),
          ne(legalListFactDetails.scoring, "held"),
        ),
      ),
    )
    .orderBy(asc(legalListItems.position), asc(legalListItems.entityId))
    .limit(VERIFICATION_LIMITS.FACTS_PER_RUN_MAX + 1);
  if (facts.length > VERIFICATION_LIMITS.FACTS_PER_RUN_MAX) {
    return { type: "too-many-facts", count: facts.length };
  }

  const sources =
    facts.length === 0
      ? []
      : await tx
          .select({
            itemEntityId: legalListItemSources.itemEntityId,
            sourceEntityId: legalListItemSources.sourceEntityId,
            sourceEntityVersionId: legalListItemSources.sourceEntityVersionId,
            locator: legalListItemSources.locator,
            quote: legalListItemSources.quote,
          })
          .from(legalListItemSources)
          .where(
            and(
              eq(legalListItemSources.workspaceId, workspaceId),
              inArray(
                legalListItemSources.itemEntityId,
                facts.map((fact) => fact.factEntityId),
              ),
              ne(legalListItemSources.verificationStatus, "rejected"),
            ),
          )
          .orderBy(
            asc(legalListItemSources.createdAt),
            asc(legalListItemSources.id),
          )
          .limit(
            VERIFICATION_LIMITS.FACTS_PER_RUN_MAX *
              VERIFICATION_LIMITS.SOURCES_PER_FACT_MAX,
          );

  const sourcesByFact = new Map<SafeId<"entity">, VerificationEvidenceSource[]>();
  for (const { itemEntityId, ...source } of sources) {
    const bucket = sourcesByFact.get(itemEntityId);
    if (bucket === undefined) {
      sourcesByFact.set(itemEntityId, [source]);
    } else if (bucket.length < VERIFICATION_LIMITS.SOURCES_PER_FACT_MAX) {
      bucket.push(source);
    }
  }

  return {
    type: "read",
    evidence: {
      listId,
      facts: facts.map(
        (fact): VerificationEvidenceFact => ({
          factEntityId: fact.factEntityId,
          text: fact.text,
          occurredOn: fact.occurredOn,
          occurredOnPrecision: fact.occurredOnPrecision,
          evidenceKind: fact.evidenceKind,
          medium: fact.medium,
          confidence: fact.confidence,
          interpretationNote: fact.interpretationNote,
          sources: sourcesByFact.get(fact.factEntityId) ?? [],
        }),
      ),
    },
  };
};
