import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

/**
 * Revert a resolved suggestion back to pending, clearing the resolution
 * fields. `entity update` permission. Idempotent: reverting an already
 * pending row simply affects no rows and returns `{ updated: false }`.
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
  async function* ({ workspaceId, params, safeDb }) {
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — inverse of resolve; clears the row's own resolution
        // trail (resolvedByUserId / resolvedAt) back to pending. No separate
        // audit_log row, matching the create/resolve handlers.
        const rows = await tx
          .update(docxSuggestions)
          .set({
            status: "pending",
            appliedMode: null,
            resolvedByUserId: null,
            resolvedAt: null,
          })
          .where(
            and(
              eq(docxSuggestions.id, params.suggestionId),
              eq(docxSuggestions.entityId, params.entityId),
              eq(docxSuggestions.workspaceId, workspaceId),
            ),
          )
          .returning({ id: docxSuggestions.id });
        return rows;
      }),
    );

    return Result.ok({ updated: updated.length > 0 });
  },
);

export default revertDocxSuggestion;
