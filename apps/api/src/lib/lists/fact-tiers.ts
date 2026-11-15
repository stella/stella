/**
 * Reads of a list's source kinds and of the tier they give its facts. Every
 * reader of a fact's footing (the record list, a verification's claims and
 * its record conflicts) goes through here, so they cannot disagree.
 */

import { panic } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";

import { LIST_SOURCE_KINDS } from "@stll/api-contract/list-source-kinds";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListItemSources,
  legalLists,
  legalListSourceDocuments,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { factTier, sourceKindOrDefault } from "@/api/lib/lists/source-kind";
import type { FactTier, SourceKind } from "@/api/lib/lists/source-kind";

type ListScope = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
};

/** The refusal code of a kind read or write naming a list or document the
 *  matter does not hold; the fact extraction start refuses with it too. */
export const LIST_OR_DOCUMENT_NOT_FOUND = "list_or_document_not_found";

type ListSourceScope =
  | { type: "found" }
  | { type: "list-not-found" }
  | { type: "documents-not-found"; missing: SafeId<"entity">[] };

/** Whether the list and every named document exist in the matter, so a
 *  kind is never read or set for something that is not there. */
export const readListSourceScope = async ({
  tx,
  workspaceId,
  listId,
  documentEntityIds,
}: ListScope & {
  documentEntityIds: readonly SafeId<"entity">[];
}): Promise<ListSourceScope> => {
  const list = await tx
    .select({ id: legalLists.id })
    .from(legalLists)
    .where(
      and(eq(legalLists.id, listId), eq(legalLists.workspaceId, workspaceId)),
    )
    .limit(1);
  if (list.length === 0) {
    return { type: "list-not-found" };
  }
  const found = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "document"),
        inArray(entities.id, [...documentEntityIds]),
      ),
    )
    .limit(documentEntityIds.length);
  const foundIds = new Set(found.map((row) => row.id));
  const missing = documentEntityIds.filter((id) => !foundIds.has(id));
  return missing.length === 0
    ? { type: "found" }
    : { type: "documents-not-found", missing };
};

/** The kind of each named document on the list; every one is answered. */
export const readSourceKinds = async ({
  tx,
  workspaceId,
  listId,
  documentIds,
}: ListScope & {
  documentIds: readonly SafeId<"entity">[];
}): Promise<ReadonlyMap<SafeId<"entity">, SourceKind>> => {
  const unique = [...new Set(documentIds)];
  const set =
    unique.length === 0
      ? []
      : await tx
          .select({
            documentEntityId: legalListSourceDocuments.documentEntityId,
            sourceKind: legalListSourceDocuments.sourceKind,
          })
          .from(legalListSourceDocuments)
          .where(
            and(
              eq(legalListSourceDocuments.workspaceId, workspaceId),
              eq(legalListSourceDocuments.listId, listId),
              inArray(legalListSourceDocuments.documentEntityId, unique),
            ),
          )
          .limit(unique.length);
  const kinds = new Map(
    set.map((row) => [row.documentEntityId, row.sourceKind]),
  );
  return new Map(
    unique.map((id) => [id, sourceKindOrDefault(kinds.get(id) ?? null)]),
  );
};

/**
 * The tier of each named fact of the list, from the sources linked to it
 * that have not been rejected; every one is answered.
 */
export const readFactTiers = async ({
  tx,
  workspaceId,
  listId,
  factIds,
}: ListScope & {
  factIds: readonly SafeId<"entity">[];
}): Promise<ReadonlyMap<SafeId<"entity">, FactTier>> => {
  const unique = [...new Set(factIds)];
  // One row per fact and distinct kind its sources cite (an unclassified
  // document reads as no kind), so the read is bounded by the facts asked.
  const cited =
    unique.length === 0
      ? []
      : await tx
          .select({
            factEntityId: legalListItemSources.itemEntityId,
            sourceKind: legalListSourceDocuments.sourceKind,
          })
          .from(legalListItemSources)
          .leftJoin(
            legalListSourceDocuments,
            and(
              eq(
                legalListSourceDocuments.workspaceId,
                legalListItemSources.workspaceId,
              ),
              eq(legalListSourceDocuments.listId, legalListItemSources.listId),
              eq(
                legalListSourceDocuments.documentEntityId,
                legalListItemSources.sourceEntityId,
              ),
            ),
          )
          .where(
            and(
              eq(legalListItemSources.workspaceId, workspaceId),
              eq(legalListItemSources.listId, listId),
              inArray(legalListItemSources.itemEntityId, unique),
              ne(legalListItemSources.verificationStatus, "rejected"),
            ),
          )
          .groupBy(
            legalListItemSources.itemEntityId,
            legalListSourceDocuments.sourceKind,
          )
          .limit(unique.length * (LIST_SOURCE_KINDS.length + 1));
  const kindsByFact = new Map<SafeId<"entity">, SourceKind[]>(
    unique.map((id) => [id, []]),
  );
  for (const { factEntityId, sourceKind } of cited) {
    (
      kindsByFact.get(factEntityId) ??
      panic("A source row names a fact that was not asked for")
    ).push(sourceKindOrDefault(sourceKind));
  }
  return new Map([...kindsByFact].map(([id, kinds]) => [id, factTier(kinds)]));
};
