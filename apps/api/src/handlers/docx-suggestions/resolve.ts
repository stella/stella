import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { docxSuggestions } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { syncReviewFindingsForSuggestions } from "@/api/lib/document-review/suggestion-finding-sync";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

import { tResolveDocxSuggestionBody } from "./schemas";

/**
 * Resolve a pending suggestion to accepted or rejected, recording who
 * resolved it and when (the audit trail). `entity update` permission.
 *
 * The `status = 'pending'` precondition lives in the `WHERE` clause and the
 * affected-row count is the source of truth (per the check-then-act rule),
 * so two concurrent resolves cannot both win and an already-resolved row is
 * a no-op `{ updated: false }` rather than a silent double-write.
 *
 * When the row came from a document review, the same write resolves the
 * finding behind it: accepting a redline here and accepting the finding in the
 * review list are one act, so they are one transaction.
 */
const resolveDocxSuggestion = createSafeHandler(
  {
    contract: "patch",
    description:
      "Record a decision on one pending redline suggestion: accepted (with " +
      "the mode the change was applied in) or rejected. This records the " +
      "decision only and does not edit the document file, so accept a " +
      "suggestion only once its change is in the document. A suggestion that " +
      "is no longer pending answers { updated: false } and is left as it is; " +
      "a linked document-review finding takes the same decision.",
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: {
      type: "capability",
      confirmation: "required",
      reason: "document_processing",
      consumesServices: false,
    },
    realtime: noResourceSetUpdates(
      "The document review store updates resolved suggestions locally and hydrates them when the document opens.",
    ),
    params: workspaceParams({
      entityId: tSafeId("entity"),
      suggestionId: tSafeId("docxSuggestion"),
    }),
    body: tResolveDocxSuggestionBody,
  },
  async function* ({
    workspaceId,
    params,
    body,
    recordAuditEvent,
    user,
    safeDb,
  }) {
    // Apply-mode is carried only on an acceptance (required there by the
    // discriminated body); a rejection stores none.
    const appliedMode = body.status === "accepted" ? body.appliedMode : null;

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — the audit trail is the row itself: this write records
        // resolvedByUserId + resolvedAt (who resolved it, when). A separate
        // audit_log row would duplicate that with no added accountability. The
        // linked review finding is different: a reviewer decision is audited
        // wherever it is taken, which the sync below does.
        const rows = await tx
          .update(docxSuggestions)
          .set({
            status: body.status,
            appliedMode,
            resolvedByUserId: user.id,
            resolvedAt: new Date(),
          })
          .where(
            and(
              eq(docxSuggestions.id, params.suggestionId),
              eq(docxSuggestions.entityId, params.entityId),
              eq(docxSuggestions.workspaceId, workspaceId),
              eq(docxSuggestions.status, "pending"),
            ),
          )
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
          status: body.status,
          userId: user.id,
          recordAuditEvent,
        });
        return rows;
      }),
    );

    return Result.ok({ updated: updated.length > 0 });
  },
);

export default resolveDocxSuggestion;
