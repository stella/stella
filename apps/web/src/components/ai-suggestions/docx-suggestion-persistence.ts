/**
 * DOCX-suggestion persistence transport.
 *
 * A single, shared entry point for writing a suggestion's resolution
 * (accepted / rejected) or a revert to the server, used by every surface
 * that resolves suggestions so they classify the outcome identically.
 *
 * The classification is the important part. Both endpoints only mutate a
 * row when its server-side precondition holds (resolve requires
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

import { Result } from "better-result";

import type { FolioAIEditApplyMode } from "@stll/folio-react";

import { api } from "@/lib/api";

export type DocxResolveResult = "synced" | "stale" | "failed";

type ResolveDocxSuggestionRequestArgs = {
  workspaceId: string;
  entityId: string;
  suggestionId: string;
  status: "accepted" | "rejected";
  /**
   * Apply mode the acceptance landed in. Required (non-null) for an
   * accept; ignored for a reject, where the server stores no mode.
   */
  appliedMode: FolioAIEditApplyMode | null;
};

type RevertDocxSuggestionRequestArgs = {
  workspaceId: string;
  entityId: string;
  suggestionId: string;
};

/**
 * Resolve a suggestion server-side as accepted or rejected. Builds the
 * discriminated body the endpoint expects (an accept carries its
 * `appliedMode`; a reject carries none).
 */
export const resolveDocxSuggestionRequest = async ({
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
  const result = await Result.tryPromise(
    async () =>
      await api["docx-suggestions"]({ workspaceId })
        .entity({ entityId })
        .suggestion({ suggestionId })
        .resolve.patch(body),
  );
  if (Result.isError(result)) {
    return "failed";
  }
  if (result.value.error) {
    return "failed";
  }
  return result.value.data.updated ? "synced" : "stale";
};

/**
 * Revert a resolved suggestion back to pending server-side.
 */
export const revertDocxSuggestionRequest = async ({
  workspaceId,
  entityId,
  suggestionId,
}: RevertDocxSuggestionRequestArgs): Promise<DocxResolveResult> => {
  const result = await Result.tryPromise(
    async () =>
      await api["docx-suggestions"]({ workspaceId })
        .entity({ entityId })
        .suggestion({ suggestionId })
        .revert.patch(),
  );
  if (Result.isError(result)) {
    return "failed";
  }
  if (result.value.error) {
    return "failed";
  }
  return result.value.data.updated ? "synced" : "stale";
};
