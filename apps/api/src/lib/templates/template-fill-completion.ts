export const TEMPLATE_FILL_COMPLETION_MODES = [
  "require_complete",
  "allow_partial",
] as const;

export type TemplateFillCompletionMode =
  (typeof TEMPLATE_FILL_COMPLETION_MODES)[number];

export const DEFAULT_TEMPLATE_FILL_COMPLETION_MODE =
  "require_complete" satisfies TemplateFillCompletionMode;

type NonEmptyPlaceholders = readonly [string, ...string[]];

type TemplateFillCompletionDecision =
  | { type: "complete" }
  | {
      type: "accepted_partial";
      unmatchedPlaceholders: NonEmptyPlaceholders;
    }
  | {
      type: "rejected_partial";
      unmatchedPlaceholders: NonEmptyPlaceholders;
    };

type DecideTemplateFillCompletionOptions = {
  mode: TemplateFillCompletionMode;
  unmatchedPlaceholders: readonly string[];
};

/**
 * Turn renderer diagnostics plus the caller's declared policy into a closed
 * decision. Partial-success and partial-error states both carry a statically
 * non-empty placeholder list; an empty list can only produce `complete`.
 */
export const decideTemplateFillCompletion = ({
  mode,
  unmatchedPlaceholders,
}: DecideTemplateFillCompletionOptions): TemplateFillCompletionDecision => {
  const firstPlaceholder = unmatchedPlaceholders.at(0);
  if (firstPlaceholder === undefined) {
    return { type: "complete" };
  }

  const nonEmptyPlaceholders: NonEmptyPlaceholders = [
    firstPlaceholder,
    ...unmatchedPlaceholders.slice(1),
  ];
  if (mode === "allow_partial") {
    return {
      type: "accepted_partial",
      unmatchedPlaceholders: nonEmptyPlaceholders,
    };
  }

  return {
    type: "rejected_partial",
    unmatchedPlaceholders: nonEmptyPlaceholders,
  };
};
