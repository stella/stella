import { Result } from "better-result";
import { and, count, eq } from "drizzle-orm";

import {
  DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
  DOCX_SUGGESTIONS_PENDING_MAX,
} from "@stll/api-contract";

import { chatThreads, docxSuggestions, entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { validateDocxSuggestionOperations } from "@/api/lib/folio-operation-validation";

import { tCreateDocxSuggestionsBody } from "./schemas";

type CreatedSuggestion = { ref: string; id: SafeId<"docxSuggestion"> };

const CREATE_OUTCOME = {
  created: "created",
  entityNotFound: "entity-not-found",
  pendingLimit: "pending-limit",
} as const;

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
    const validatedOperations = validateDocxSuggestionOperations(
      body.suggestions.map((suggestion) => suggestion.opPayload),
    );
    if (validatedOperations === undefined) {
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
    let sourceDataWorkspaceIds: SafeId<"workspace">[] = [];
    if (originThreadId !== null) {
      const threadRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              workspaceId: chatThreads.workspaceId,
              dataWorkspaceIds: chatThreads.dataWorkspaceIds,
            })
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
      // A suggestion restates whatever the thread put in front of the model,
      // so it inherits the thread's provenance. Reading the thread row through
      // the scoped transaction is what narrows that scope to the caller: the
      // thread's own policy only returns it while every matter in
      // `data_workspace_ids` is still accessible, which is exactly the subset
      // this table's insert check requires.
      sourceDataWorkspaceIds = thread.dataWorkspaceIds;
    }

    const prepared = body.suggestions.map((suggestion, index) => {
      const operation = validatedOperations[index];
      if (operation === undefined) {
        return unreachable(
          "Folio operation validation returned fewer operations than supplied",
        );
      }
      return {
        ref: suggestion.ref,
        row: {
          id: createSafeId<"docxSuggestion">(),
          workspaceId,
          entityId: params.entityId,
          originThreadId,
          sourceDataWorkspaceIds,
          opPayload: operation,
          comment: suggestion.comment ?? null,
          severity: suggestion.severity,
          area: suggestion.area,
          status: "pending" as const,
        },
      };
    });

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Locking the document row serializes concurrent creates for it, so
        // the pending count below cannot be raced past the cap.
        const lockedEntities = await tx
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              eq(entities.id, params.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .for("update");
        if (lockedEntities.length === 0) {
          return { type: CREATE_OUTCOME.entityNotFound };
        }
        const pendingRows = await tx
          .select({ pending: count() })
          .from(docxSuggestions)
          .where(
            and(
              eq(docxSuggestions.workspaceId, workspaceId),
              eq(docxSuggestions.entityId, params.entityId),
              eq(docxSuggestions.status, "pending"),
            ),
          )
          .limit(1);
        const pending = pendingRows.at(0)?.pending ?? 0;
        if (pending + prepared.length > DOCX_SUGGESTIONS_PENDING_MAX) {
          return { type: CREATE_OUTCOME.pendingLimit };
        }
        // audit: skip — review-flow bookkeeping. Suggestions are proposals,
        // not document mutations; a batch can be 200 rows and would flood the
        // audit log. The durable audit trail lives on the row
        // (resolvedByUserId / resolvedAt), written when a suggestion is
        // actually accepted or rejected.
        // One statement stamps every row with the same `created_at` (the
        // transaction start time), which clients read as the batch identity.
        const inserted = await tx
          .insert(docxSuggestions)
          .values(prepared.map((item) => item.row))
          .returning({ createdAt: docxSuggestions.createdAt });
        const createdAt =
          inserted.at(0)?.createdAt ??
          unreachable("An insert of a non-empty batch returns its rows");
        return { type: CREATE_OUTCOME.created, createdAt };
      }),
    );
    switch (outcome.type) {
      case CREATE_OUTCOME.entityNotFound:
        return Result.err(
          new HandlerError({ status: 404, message: "Document not found." }),
        );
      case CREATE_OUTCOME.pendingLimit:
        return Result.err(
          new HandlerError({
            status: 409,
            code: DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
            message: `A document can hold at most ${DOCX_SUGGESTIONS_PENDING_MAX} pending suggestions.`,
          }),
        );
      case CREATE_OUTCOME.created: {
        const items: CreatedSuggestion[] = prepared.map((item) => ({
          ref: item.ref,
          id: item.row.id,
        }));
        return Result.ok({ createdAt: outcome.createdAt, items });
      }
      default:
        return unreachable(`Unhandled create outcome: ${String(outcome)}`);
    }
  },
);

export default createDocxSuggestions;
