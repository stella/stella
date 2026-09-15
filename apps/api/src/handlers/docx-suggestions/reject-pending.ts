import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { syncReviewFindingForSuggestion } from "@/api/lib/document-review/suggestion-finding-sync";

import { tRejectPendingDocxSuggestionsBody } from "./schemas";

/**
 * Reject a set of pending suggestions in one write, recording who rejected
 * them and when. `entity update` permission.
 *
 * Same precondition as the single resolve: `status = 'pending'` lives in the
 * `WHERE` clause, so an id that is already resolved, belongs to another
 * entity, or is invisible to this workspace is skipped rather than
 * overwritten. The returned ids are the rows this call actually rejected.
 */
const rejectPendingDocxSuggestions = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "document_processing" },
    params: workspaceParams({ entityId: tSafeId("entity") }),
    body: tRejectPendingDocxSuggestionsBody,
  },
  async function* ({
    workspaceId,
    params,
    body,
    recordAuditEvent,
    user,
    safeDb,
  }) {
    const rejected = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — the audit trail is each row itself: this write records
        // resolvedByUserId + resolvedAt, matching the single resolve. Linked
        // review findings are audited by the sync below.
        const rows = await tx
          .update(docxSuggestions)
          .set({
            status: "rejected",
            appliedMode: null,
            resolvedByUserId: user.id,
            resolvedAt: new Date(),
          })
          .where(
            and(
              inArray(docxSuggestions.id, body.suggestionIds),
              eq(docxSuggestions.entityId, params.entityId),
              eq(docxSuggestions.workspaceId, workspaceId),
              eq(docxSuggestions.status, "pending"),
            ),
          )
          .returning({
            id: docxSuggestions.id,
            originReviewFindingId: docxSuggestions.originReviewFindingId,
          });

        for (const row of rows) {
          if (row.originReviewFindingId === null) {
            continue;
          }
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- ordered write: each sync locks and audits one finding in this transaction, which cannot run statements concurrently
          await syncReviewFindingForSuggestion({
            tx,
            workspaceId,
            findingId: row.originReviewFindingId,
            status: "rejected",
            userId: user.id,
            recordAuditEvent,
          });
        }
        return rows;
      }),
    );

    return Result.ok({ rejectedIds: rejected.map((row) => row.id) });
  },
);

export default rejectPendingDocxSuggestions;
