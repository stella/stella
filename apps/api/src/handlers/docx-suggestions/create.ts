import { Result } from "better-result";

import { docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

import { tCreateDocxSuggestionsBody } from "./schemas";

type CreatedSuggestion = { ref: string; id: SafeId<"docxSuggestion"> };

/**
 * Batch-persist AI DOCX suggestions the client just queued for review.
 * Ids are server-generated and echoed back keyed by the client `ref` so
 * the web store can adopt them. `entity update` permission: queuing edits
 * to the document is an entity mutation. The `(entity_id, workspace_id)`
 * composite FK enforces the entity belongs to the server-validated
 * workspace, so a client cannot attach suggestions to another tenant's
 * document.
 */
const createDocxSuggestions = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "document_processing" },
    params: workspaceParams({ entityId: tSafeId("entity") }),
    body: tCreateDocxSuggestionsBody,
  },
  async function* ({ workspaceId, params, body, safeDb }) {
    const prepared = body.suggestions.map((suggestion) => ({
      ref: suggestion.ref,
      row: {
        id: createSafeId<"docxSuggestion">(),
        workspaceId,
        entityId: params.entityId,
        originThreadId: body.originThreadId ?? null,
        opPayload: suggestion.opPayload,
        comment: suggestion.comment ?? null,
        severity: suggestion.severity,
        area: suggestion.area,
        status: "pending" as const,
      },
    }));

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — review-flow bookkeeping. Suggestions are proposals,
        // not document mutations; a batch can be 200 rows and would flood the
        // audit log. The durable audit trail lives on the row
        // (resolvedByUserId / resolvedAt), written when a suggestion is
        // actually accepted or rejected.
        await tx
          .insert(docxSuggestions)
          .values(prepared.map((item) => item.row));
      }),
    );

    const items: CreatedSuggestion[] = prepared.map((item) => ({
      ref: item.ref,
      id: item.row.id,
    }));
    return Result.ok({ items });
  },
);

export default createDocxSuggestions;
