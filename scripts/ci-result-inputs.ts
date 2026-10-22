import { panic } from "better-result";

// ci-result's outcome step reads job results and plan outputs from its own
// script text (see .github/workflows/ci.yml): an environment value above
// Linux's 128 KiB limit stops a step before it starts. Tests render the two
// expressions the way GitHub does before running the script.

// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const expression = (value: string) => ["$", "{{ ", value, " }}"].join("");

export const NEEDS_EXPRESSION = expression("toJSON(needs)");
export const PLAN_EXPRESSION = expression("toJSON(needs.ci-plan.outputs)");

/** The outcome script as GitHub runs it for these job results and plan outputs. */
export const renderResultInputs = (
  run: string,
  inputs: { needs: string; plan: string },
): string => {
  if (!run.includes(NEEDS_EXPRESSION) || !run.includes(PLAN_EXPRESSION)) {
    return panic("the outcome script no longer embeds its inputs");
  }
  return run
    .replace(NEEDS_EXPRESSION, () => inputs.needs)
    .replace(PLAN_EXPRESSION, () => inputs.plan);
};
