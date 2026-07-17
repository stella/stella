import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { folioDocumentOperationBatchSchema } from "@stll/folio-agents";
import { FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION } from "@stll/folio-core/server";

import { chatThreads, docxSuggestions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
    // Validate every op against folio's contract before persisting. This
    // endpoint is directly reachable by any `entity:update` caller, so an
    // unvalidated `opPayload` (null, a primitive, or a malformed op such as
    // `insertSignatureTable` with `parties: null`) would otherwise persist a
    // row that later crashes the hydration/preview path for every reader of
    // the entity. Reuse the exact strict batch parser the chat tool delegates
    // per-operation shape checking to, rather than duplicating the contract.
    // No await: folio's batch schema is a synchronous valibot schema, so
    // `~standard.validate` returns the result directly (matches the chat
    // tool's own usage; if folio ever turns it async this line fails
    // typecheck).
    const opValidation = folioDocumentOperationBatchSchema[
      "~standard"
    ].validate({
      version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
      operations: body.suggestions.map((suggestion) => suggestion.opPayload),
    });
    if (opValidation.issues !== undefined) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid suggestion operation payload.",
        }),
      );
    }

    // Ownership ids come from server-validated sources: the origin thread,
    // when supplied, must belong to this validated workspace. The FK alone
    // only checks the thread exists, so a body-supplied id could otherwise
    // link this workspace's suggestion to another tenant's thread.
    const originThreadId = body.originThreadId ?? null;
    if (originThreadId !== null) {
      const threadRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ workspaceId: chatThreads.workspaceId })
            .from(chatThreads)
            .where(eq(chatThreads.id, originThreadId))
            .limit(1),
        ),
      );
      const thread = threadRows.at(0);
      if (!thread || thread.workspaceId !== workspaceId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "originThreadId does not belong to this workspace.",
          }),
        );
      }
    }

    const prepared = body.suggestions.map((suggestion) => ({
      ref: suggestion.ref,
      row: {
        id: createSafeId<"docxSuggestion">(),
        workspaceId,
        entityId: params.entityId,
        originThreadId,
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
