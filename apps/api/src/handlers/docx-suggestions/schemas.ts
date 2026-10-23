import * as v from "valibot";

import { DOCX_SUGGESTIONS_PENDING_MAX } from "@stll/api-contract";

import { resourceIdSchema } from "@/api/lib/custom-schema";

/** Ceiling on one persist batch; mirrors the edit tool's operation cap. */
const MAX_DOCX_SUGGESTIONS_PER_BATCH = 200;
/** Default page size for the entity suggestion list. The max is
 *  `DOCX_SUGGESTIONS_PAGE_SIZE_MAX` in @stll/api-contract, which the client
 *  requests per hydration fetch. */
export const DOCX_SUGGESTIONS_PAGE_SIZE_DEFAULT = 100;

const tDocxSuggestionSeverity = v.picklist([
  "low",
  "medium",
  "high",
  "unspecified",
]);

const tDocxSuggestionApplyMode = v.picklist([
  "tracked-changes",
  "direct",
  "suggested",
]);

/**
 * Resolution input as a discriminated union on `status`: an acceptance
 * requires the `appliedMode` it was applied in; a rejection carries none.
 * This makes an accepted row with a null mode (or a rejection that smuggles
 * a mode) structurally impossible.
 */
export const tResolveDocxSuggestionBody = v.union([
  v.object({
    status: v.literal("accepted"),
    appliedMode: tDocxSuggestionApplyMode,
  }),
  v.object({ status: v.literal("rejected") }),
]);

export const tRejectPendingDocxSuggestionsBody = v.object({
  suggestionIds: v.pipe(
    v.array(resourceIdSchema("docxSuggestion")),
    v.minLength(1),
    v.maxLength(DOCX_SUGGESTIONS_PENDING_MAX),
  ),
});

/**
 * One suggestion in a persist batch. `opPayload` is the client-prepared
 * editor operation, stored opaquely. `ref` is a client-side id echoed back
 * so the web client can reconcile its optimistic in-memory rows with the
 * server ids without a second round trip.
 */
const tDocxSuggestionInput = v.object({
  ref: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  opPayload: v.unknown(),
  comment: v.optional(
    v.union([v.pipe(v.string(), v.maxLength(4000)), v.null()]),
  ),
  severity: tDocxSuggestionSeverity,
  area: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

export const tCreateDocxSuggestionsBody = v.object({
  suggestions: v.pipe(
    v.array(tDocxSuggestionInput),
    v.minLength(1),
    v.maxLength(MAX_DOCX_SUGGESTIONS_PER_BATCH),
  ),
  originThreadId: v.optional(
    v.union([resourceIdSchema("chatThread"), v.null()]),
  ),
});
