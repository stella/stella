import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { syncReviewFindingsForSuggestions } from "@/api/lib/document-review/suggestion-finding-sync";
import {
  DOCX_PENDING_CAPACITY,
  docxSuggestionsPendingLimitError,
  lockDocxSuggestionPendingCapacity,
} from "@/api/lib/docx/suggestion-pending-capacity";
import { unreachable } from "@/api/lib/errors/tagged-errors";

const REVERT_OUTCOME = {
  reverted: "reverted",
  unchanged: "unchanged",
  pendingLimit: "pending-limit",
} as const;

/**
 * Revert a resolved suggestion back to pending, clearing the resolution
 * fields. `entity update` permission. The `status <> 'pending'` predicate
 * is the precondition (check-then-act in the WHERE, affected-row count is
 * authoritative): a revert only wins when the row is actually terminal, so
 * an already-pending row is a no-op `{ updated: false }` and a revert can't
 * silently override a resolve that lands concurrently.
 *
 * A revert adds a pending row, so it holds the document's pending cap like a
 * create: at the cap, reverting a resolved row is refused with the same 409.
 *
 * A suggestion staged by a document review takes its finding back with it: the
 * decision and the application are both withdrawn, leaving the finding as the
 * engine produced it.
 */
const revertDocxSuggestion = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "document_processing" },
    params: workspaceParams({
      entityId: tSafeId("entity"),
      suggestionId: tSafeId("docxSuggestion"),
    }),
  },
  async function* ({ workspaceId, params, recordAuditEvent, safeDb, user }) {
    const matchesResolvedRow = and(
      eq(docxSuggestions.id, params.suggestionId),
      eq(docxSuggestions.entityId, params.entityId),
      eq(docxSuggestions.workspaceId, workspaceId),
      ne(docxSuggestions.status, "pending"),
    );

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const capacity = await lockDocxSuggestionPendingCapacity({
          tx,
          workspaceId,
          entityId: params.entityId,
        });
        if (capacity.type === DOCX_PENDING_CAPACITY.entityNotFound) {
          return REVERT_OUTCOME.unchanged;
        }
        if (capacity.remaining === 0) {
          // Only a resolved row would add a pending one; reverting a row that
          // is already pending stays the usual no-op.
          const resolved = await tx
            .select({ id: docxSuggestions.id })
            .from(docxSuggestions)
            .where(matchesResolvedRow)
            .limit(1);
          return resolved.length > 0
            ? REVERT_OUTCOME.pendingLimit
            : REVERT_OUTCOME.unchanged;
        }

        // audit: skip — inverse of resolve; clears the row's own resolution
        // trail (resolvedByUserId / resolvedAt) back to pending. No separate
        // audit_log row, matching the create/resolve handlers. Reopening a
        // linked review finding is audited by the sync below, as taking the
        // decision was.
        const rows = await tx
          .update(docxSuggestions)
          .set({
            status: "pending",
            appliedMode: null,
            resolvedByUserId: null,
            resolvedAt: null,
          })
          .where(matchesResolvedRow)
          .returning({
            id: docxSuggestions.id,
            originReviewFindingId: docxSuggestions.originReviewFindingId,
          });

        await syncReviewFindingsForSuggestions({
          tx,
          workspaceId,
          findingIds: rows.flatMap((row) =>
            row.originReviewFindingId === null
              ? []
              : [row.originReviewFindingId],
          ),
          status: "pending",
          userId: user.id,
          recordAuditEvent,
        });
        return rows.length > 0
          ? REVERT_OUTCOME.reverted
          : REVERT_OUTCOME.unchanged;
      }),
    );

    switch (outcome) {
      case REVERT_OUTCOME.reverted:
        return Result.ok({ updated: true });
      case REVERT_OUTCOME.unchanged:
        return Result.ok({ updated: false });
      case REVERT_OUTCOME.pendingLimit:
        return Result.err(docxSuggestionsPendingLimitError());
      default:
        return unreachable(`Unhandled revert outcome: ${String(outcome)}`);
    }
  },
);

export default revertDocxSuggestion;
