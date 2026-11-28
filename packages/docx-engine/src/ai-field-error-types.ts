/**
 * Why a drafted field has no value. `truncated` is the model stopping at the
 * output ceiling mid-value, which must never be written: a legal instrument
 * whose scope clause ends mid-word reads as a complete sentence to no one but
 * is silent about the cut. `interrupted` is a run that ended without
 * reporting a finish at all (a cancelled fill, a lifecycle regression).
 */
export type AiFieldFailureReason =
  "empty" | "generation-failed" | "interrupted" | "truncated";

/** One field the fill could not draft, carried out of the fill so every
 *  boundary reports it rather than shipping the document as if complete. */
export type AiFieldError = {
  fieldPath: string;
  /** Exact value location, with zero-based indices at each array boundary. */
  valuePath: string;
  /** 1-based row index for an array-scoped draft; null for a top-level field. */
  itemIndex: number | null;
  reason: AiFieldFailureReason;
  message: string;
};
