/**
 * DOCX-suggestion persistence transport.
 *
 * The single entry point for every server write to a suggestion row: create,
 * resolve (accepted / rejected), revert, and the bulk reject a new chat thread
 * can issue. Each successful write that moves a row into or out of `pending`
 * also updates the hydration cache here, so no caller can write the server and
 * leave the cache listing a stale pending set.
 *
 * Resolve and revert classify the outcome. Both endpoints only mutate a row
 * when its server-side precondition holds (resolve requires
 * status='pending'; revert requires status<>'pending') and report the
 * affected-row count as `{ updated }`. So the caller can tell three cases
 * apart and reconcile local/editor state accordingly:
 *
 *   - "synced"  the write landed; server and editor agree.
 *   - "stale"   the row was NOT in the expected state (already resolved
 *               elsewhere / a concurrent write won). Local state should be
 *               reconciled, not treated as a transport failure.
 *   - "failed"  the request itself failed (network / server error).
 *
 * Analytics capture is deliberately NOT done here: callers own the toast
 * and telemetry decision so a batch can surface a single toast for many
 * per-item results.
 */

import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import type { UnhandledException } from "better-result";

import { DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE } from "@stll/api-contract";
import type { FolioAIEditApplyMode } from "@stll/folio-react";

import {
  DOCX_SUGGESTION_CACHE_WRITE,
  pendingDocxSuggestionRow,
  writeDocxSuggestionsCache,
} from "@/components/ai-suggestions/docx-suggestion-cache";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { api } from "@/lib/api";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export type DocxResolveResult = "synced" | "stale" | "failed";

type DocxSuggestionTarget = {
  queryClient: QueryClient;
  workspaceId: string;
  entityId: string;
};

type CreateDocxSuggestionsRequestArgs = DocxSuggestionTarget & {
  chatThreadId: ChatThreadId | undefined;
  suggestions: readonly ReviewSuggestion[];
};

export const CREATE_DOCX_SUGGESTIONS_ERROR = {
  pendingLimit: "pending-limit",
  failed: "failed",
} as const;

type CreateDocxSuggestionsError =
  | {
      type: typeof CREATE_DOCX_SUGGESTIONS_ERROR.pendingLimit;
      cause: unknown;
    }
  | { type: typeof CREATE_DOCX_SUGGESTIONS_ERROR.failed; cause: unknown };

type CreateDocxSuggestionsResult = Result<
  Record<string, string>,
  CreateDocxSuggestionsError
>;

/**
 * Persist just-queued suggestions and return the server id for each client
 * ref. Suggestions without an operation have nothing to persist and are
 * skipped.
 */
export const createDocxSuggestionsRequest = async ({
  queryClient,
  workspaceId,
  entityId,
  chatThreadId,
  suggestions,
}: CreateDocxSuggestionsRequestArgs): Promise<CreateDocxSuggestionsResult> => {
  const body = suggestions.flatMap((item) =>
    item.pendingOperation === null
      ? []
      : [
          {
            ref: item.id,
            opPayload: item.pendingOperation,
            comment: item.comment ?? null,
            severity: item.severity,
            area: item.area,
          },
        ],
  );
  if (body.length === 0) {
    return Result.ok({});
  }

  const result = await Result.tryPromise({
    try: async () => {
      const response = await api["docx-suggestions"]({ workspaceId })
        .entity({ entityId })
        .put({ suggestions: body, originThreadId: chatThreadId ?? null });
      return unwrapEden(response);
    },
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    // The server refuses a batch that would take the document past its
    // pending cap; those suggestions stay client-only, like any failed create.
    const pendingLimit =
      APIError.is(result.error) &&
      result.error.code === DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE;
    return Result.err({
      type: pendingLimit
        ? CREATE_DOCX_SUGGESTIONS_ERROR.pendingLimit
        : CREATE_DOCX_SUGGESTIONS_ERROR.failed,
      cause: result.error,
    });
  }

  const suggestionsByRef = new Map(suggestions.map((item) => [item.id, item]));
  const rows = result.value.items.flatMap(({ ref, id }) => {
    const suggestion = suggestionsByRef.get(ref);
    const row =
      suggestion === undefined
        ? null
        : pendingDocxSuggestionRow(suggestion, id);
    return row === null ? [] : [row];
  });
  await writeDocxSuggestionsCache({
    queryClient,
    workspaceId,
    entityId,
    write: { type: DOCX_SUGGESTION_CACHE_WRITE.enterPending, rows },
  });

  return Result.ok(
    Object.fromEntries(result.value.items.map(({ ref, id }) => [ref, id])),
  );
};

type ResolveDocxSuggestionRequestArgs = DocxSuggestionTarget & {
  suggestionId: string;
  status: "accepted" | "rejected";
  /**
   * Apply mode the acceptance landed in. Required (non-null) for an
   * accept; ignored for a reject, where the server stores no mode.
   */
  appliedMode: FolioAIEditApplyMode | null;
};

/**
 * Resolve a suggestion server-side as accepted or rejected. Builds the
 * discriminated body the endpoint expects (an accept carries its
 * `appliedMode`; a reject carries none).
 */
export const resolveDocxSuggestionRequest = async ({
  queryClient,
  workspaceId,
  entityId,
  suggestionId,
  status,
  appliedMode,
}: ResolveDocxSuggestionRequestArgs): Promise<DocxResolveResult> => {
  const body =
    status === "accepted"
      ? { status, appliedMode: appliedMode ?? "tracked-changes" }
      : { status };
  const result = await Result.tryPromise(async () => {
    const response = await api["docx-suggestions"]({ workspaceId })
      .entity({ entityId })
      .suggestion({ suggestionId })
      .resolve.patch(body);
    return unwrapEden(response);
  });
  if (Result.isError(result)) {
    return "failed";
  }
  // Either way the server row is no longer pending: this call resolved it, or
  // another write already had.
  await writeDocxSuggestionsCache({
    queryClient,
    workspaceId,
    entityId,
    write: {
      type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
      suggestionIds: [suggestionId],
    },
  });
  return result.value.updated ? "synced" : "stale";
};

type RevertDocxSuggestionRequestArgs = DocxSuggestionTarget & {
  suggestion: ReviewSuggestion;
};

/**
 * Revert a resolved suggestion back to pending server-side.
 */
export const revertDocxSuggestionRequest = async ({
  queryClient,
  workspaceId,
  entityId,
  suggestion,
}: RevertDocxSuggestionRequestArgs): Promise<DocxResolveResult> => {
  const result = await Result.tryPromise(async () => {
    const response = await api["docx-suggestions"]({ workspaceId })
      .entity({ entityId })
      .suggestion({ suggestionId: suggestion.id })
      .revert.patch();
    return unwrapEden(response);
  });
  if (Result.isError(result)) {
    return "failed";
  }
  // Either way the server row is pending now: this call reverted it, or it
  // already was.
  const row = pendingDocxSuggestionRow(
    suggestion,
    toSafeId<"docxSuggestion">(suggestion.id),
  );
  if (row !== null) {
    await writeDocxSuggestionsCache({
      queryClient,
      workspaceId,
      entityId,
      write: { type: DOCX_SUGGESTION_CACHE_WRITE.enterPending, rows: [row] },
    });
  }
  return result.value.updated ? "synced" : "stale";
};

type RejectPendingDocxSuggestionsRequestArgs = DocxSuggestionTarget & {
  suggestionIds: readonly string[];
};

/**
 * Reject every listed suggestion that is still pending server-side. Ids that
 * are already resolved are skipped by the server and leave the pending cache
 * all the same, since none of them is pending afterwards.
 */
export const rejectPendingDocxSuggestionsRequest = async ({
  queryClient,
  workspaceId,
  entityId,
  suggestionIds,
}: RejectPendingDocxSuggestionsRequestArgs): Promise<
  Result<void, UnhandledException>
> => {
  // No chunking: create caps a document's pending rows at the same bound the
  // bulk reject body accepts, so every pending id fits in one request.
  const result = await Result.tryPromise(async () => {
    const response = await api["docx-suggestions"]({ workspaceId })
      .entity({ entityId })
      ["reject-pending"].patch({
        suggestionIds: suggestionIds.map((id) =>
          toSafeId<"docxSuggestion">(id),
        ),
      });
    return unwrapEden(response);
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  await writeDocxSuggestionsCache({
    queryClient,
    workspaceId,
    entityId,
    write: {
      type: DOCX_SUGGESTION_CACHE_WRITE.leavePending,
      suggestionIds,
    },
  });
  return Result.ok(undefined);
};
