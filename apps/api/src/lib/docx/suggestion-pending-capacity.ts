/**
 * The per-document cap on pending DOCX suggestions, owned in one place.
 *
 * Every write that adds a pending row (the batch create, a revert, review
 * staging) locks the document row through here before counting, so two
 * writers cannot both read room for the last slot. The client's pending
 * hydration and the bulk reject both assume the cap holds.
 */

import { and, count, eq } from "drizzle-orm";

import {
  DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
  DOCX_SUGGESTIONS_PENDING_MAX,
} from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { docxSuggestions, entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const DOCX_PENDING_CAPACITY = {
  available: "available",
  entityNotFound: "entity-not-found",
} as const;

export type DocxPendingCapacity =
  | {
      type: typeof DOCX_PENDING_CAPACITY.available;
      /** How many more pending rows the document may take. */
      remaining: number;
    }
  | { type: typeof DOCX_PENDING_CAPACITY.entityNotFound };

type LockDocxSuggestionPendingCapacityArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

/**
 * Lock the document row and read its remaining pending capacity, in the
 * caller's transaction. The lock holds until that transaction ends, so the
 * caller's insert or revert lands before any other writer counts again.
 */
export const lockDocxSuggestionPendingCapacity = async ({
  tx,
  workspaceId,
  entityId,
}: LockDocxSuggestionPendingCapacityArgs): Promise<DocxPendingCapacity> => {
  const locked = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .for("update");
  if (locked.length === 0) {
    return { type: DOCX_PENDING_CAPACITY.entityNotFound };
  }
  const pendingRows = await tx
    .select({ pending: count() })
    .from(docxSuggestions)
    .where(
      and(
        eq(docxSuggestions.workspaceId, workspaceId),
        eq(docxSuggestions.entityId, entityId),
        eq(docxSuggestions.status, "pending"),
      ),
    )
    .limit(1);
  const pending = pendingRows.at(0)?.pending ?? 0;
  return {
    type: DOCX_PENDING_CAPACITY.available,
    remaining: Math.max(0, DOCX_SUGGESTIONS_PENDING_MAX - pending),
  };
};

/** The typed refusal for a write that would exceed the pending cap. */
export const docxSuggestionsPendingLimitError = () =>
  new HandlerError({
    status: 409,
    code: DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
    message: `A document can hold at most ${DOCX_SUGGESTIONS_PENDING_MAX} pending suggestions.`,
  });
