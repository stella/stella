import * as v from "valibot";

import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";

export const TEMPLATE_FILL_COMPLETION_MODES = [
  "require_complete",
  "allow_partial",
] as const;

export type TemplateFillCompletionMode =
  (typeof TEMPLATE_FILL_COMPLETION_MODES)[number];

export const DEFAULT_TEMPLATE_FILL_COMPLETION_MODE =
  "require_complete" satisfies TemplateFillCompletionMode;

/**
 * The `completion_mode` argument every template-rendering tool accepts. One
 * declaration so a transient fill and a persisting fill cannot drift into
 * different defaults: an omitted mode is strict on both.
 */
export const templateFillCompletionModeSchema = v.optional(
  v.picklist(TEMPLATE_FILL_COMPLETION_MODES),
  DEFAULT_TEMPLATE_FILL_COMPLETION_MODE,
);

/**
 * What kept a fill from being complete. A partial decision always carries at
 * least one of the two: a placeholder the renderer could not fill, or a field
 * whose AI draft failed (a truncated draft is reported, never written, so it
 * shows up here rather than as a cut value in the document).
 */
type TemplateFillShortfall = {
  unmatchedPlaceholders: readonly string[];
  aiFieldErrors: readonly AiFieldError[];
};

type TemplateFillCompletionDecision =
  | { type: "complete" }
  | ({ type: "accepted_partial" } & TemplateFillShortfall)
  | ({ type: "rejected_partial" } & TemplateFillShortfall);

type DecideTemplateFillCompletionOptions = {
  mode: TemplateFillCompletionMode;
} & TemplateFillShortfall;

/**
 * Turn fill diagnostics plus the caller's declared policy into a closed
 * decision. Both shortfalls are graded the same way: `require_complete`
 * rejects either one, `allow_partial` reports either one back to the caller.
 */
export const decideTemplateFillCompletion = ({
  mode,
  unmatchedPlaceholders,
  aiFieldErrors,
}: DecideTemplateFillCompletionOptions): TemplateFillCompletionDecision => {
  if (unmatchedPlaceholders.length === 0 && aiFieldErrors.length === 0) {
    return { type: "complete" };
  }

  return mode === "allow_partial"
    ? { type: "accepted_partial", unmatchedPlaceholders, aiFieldErrors }
    : { type: "rejected_partial", unmatchedPlaceholders, aiFieldErrors };
};
