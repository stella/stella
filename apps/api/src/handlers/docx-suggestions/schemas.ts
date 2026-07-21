import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

/** Ceiling on one persist batch; mirrors the edit tool's operation cap. */
export const MAX_DOCX_SUGGESTIONS_PER_BATCH = 200;
/** Default and max page size for the entity suggestion list. */
export const DOCX_SUGGESTIONS_PAGE_SIZE_DEFAULT = 100;
export const DOCX_SUGGESTIONS_PAGE_SIZE_MAX = 200;

export const tDocxSuggestionSeverity = t.Union([
  t.Literal("low"),
  t.Literal("medium"),
  t.Literal("high"),
  t.Literal("unspecified"),
]);

export const tDocxSuggestionApplyMode = t.Union([
  t.Literal("tracked-changes"),
  t.Literal("direct"),
  t.Literal("suggested"),
]);

/**
 * Resolution input as a discriminated union on `status`: an acceptance
 * requires the `appliedMode` it was applied in; a rejection carries none.
 * This makes an accepted row with a null mode (or a rejection that smuggles
 * a mode) structurally impossible.
 */
export const tResolveDocxSuggestionBody = t.Union([
  t.Object({
    status: t.Literal("accepted"),
    appliedMode: tDocxSuggestionApplyMode,
  }),
  t.Object({
    status: t.Literal("rejected"),
  }),
]);

/**
 * One suggestion in a persist batch. `opPayload` is the client-prepared
 * editor operation, stored opaquely. `ref` is a client-side id echoed back
 * so the web client can reconcile its optimistic in-memory rows with the
 * server ids without a second round trip.
 */
export const tDocxSuggestionInput = t.Object({
  ref: t.String({ minLength: 1, maxLength: 128 }),
  opPayload: t.Unknown(),
  comment: t.Optional(t.Union([t.String({ maxLength: 4000 }), t.Null()])),
  severity: tDocxSuggestionSeverity,
  area: t.String({ minLength: 1, maxLength: 128 }),
});

export const tCreateDocxSuggestionsBody = t.Object({
  suggestions: t.Array(tDocxSuggestionInput, {
    minItems: 1,
    maxItems: MAX_DOCX_SUGGESTIONS_PER_BATCH,
  }),
  originThreadId: t.Optional(t.Union([tSafeId("chatThread"), t.Null()])),
});
