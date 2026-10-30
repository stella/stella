import { Result, TaggedError } from "better-result";

import type { ConditionNode } from "@stll/conditions";

import type { PropertyContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

export const AI_COLUMN_INPUT_REQUIRED_CODE = "ai-column-input-required";

export type PropertyInput = {
  dependsOnPropertyId: SafeId<"property">;
  condition: ConditionNode | null;
};

export type NonEmptyPropertyInputs = readonly [
  PropertyInput,
  ...PropertyInput[],
];

export class AIColumnInputRequiredError extends TaggedError(
  "AIColumnInputRequiredError",
)<{
  message: string;
  code: typeof AI_COLUMN_INPUT_REQUIRED_CODE;
  candidateFileColumnIds: SafeId<"property">[];
}> {}

type InputCandidate = {
  id: SafeId<"property">;
  content: Pick<PropertyContent, "type">;
};

/**
 * The sole owner of the input invariant for a newly configured computed
 * column. Explicit inputs win; otherwise the only document-file column is
 * selected. Ambiguous and missing inputs are refused with machine-readable
 * candidate ids.
 */
export const requireComputedColumnInputs = ({
  candidates,
  inputs,
}: {
  candidates: readonly InputCandidate[];
  inputs: readonly PropertyInput[];
}): Result<NonEmptyPropertyInputs, AIColumnInputRequiredError> => {
  if (inputs.length > 0) {
    const [first, ...rest] = inputs;
    if (first) {
      return Result.ok([first, ...rest]);
    }
  }

  const candidateFileColumnIds = candidates
    .filter(({ content }) => content.type === "file")
    .map(({ id }) => id);
  const onlyFileColumn = candidateFileColumnIds.at(0);
  if (candidateFileColumnIds.length === 1 && onlyFileColumn) {
    return Result.ok([
      { dependsOnPropertyId: onlyFileColumn, condition: null },
    ]);
  }

  return Result.err(
    new AIColumnInputRequiredError({
      code: AI_COLUMN_INPUT_REQUIRED_CODE,
      message:
        "AI columns require an input; provide a dependency or keep exactly one document file column in the matter.",
      candidateFileColumnIds,
    }),
  );
};
