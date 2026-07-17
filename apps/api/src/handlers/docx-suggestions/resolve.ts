import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

import {
  tDocxSuggestionApplyMode,
  tDocxSuggestionResolvableStatus,
} from "./schemas";

/**
 * Resolve a pending suggestion to accepted or rejected, recording who
 * resolved it and when (the audit trail). `entity update` permission.
 *
 * The `status = 'pending'` precondition lives in the `WHERE` clause and the
 * affected-row count is the source of truth (per the check-then-act rule),
 * so two concurrent resolves cannot both win and an already-resolved row is
 * a no-op `{ updated: false }` rather than a silent double-write.
 */
const resolveDocxSuggestion = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "document_processing" },
    params: workspaceParams({
      entityId: tSafeId("entity"),
      suggestionId: tSafeId("docxSuggestion"),
    }),
    body: t.Object({
      status: tDocxSuggestionResolvableStatus,
      appliedMode: t.Optional(t.Union([tDocxSuggestionApplyMode, t.Null()])),
    }),
  },
  async function* ({ workspaceId, params, body, user, safeDb }) {
    // Apply-mode is only meaningful for an accept; a reject clears it.
    const appliedMode =
      body.status === "accepted" ? (body.appliedMode ?? null) : null;

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — the audit trail is the row itself: this write records
        // resolvedByUserId + resolvedAt (who resolved it, when). A separate
        // audit_log row would duplicate that with no added accountability.
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
          .returning({ id: docxSuggestions.id });
        return rows;
      }),
    );

    return Result.ok({ updated: updated.length > 0 });
  },
);

export default resolveDocxSuggestion;
