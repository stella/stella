import { panic } from "better-result";

// ci-result reads job results and plan outputs from files a short step writes
// before the outcome step (see .github/workflows/ci.yml). An environment value
// above Linux's 128 KiB limit stops a step before it starts, and a script that
// embeds an expression is evaluated as one expression, which GitHub caps at
// 21,000 characters; the outcome script is longer, so it embeds none. Tests
// render the inputs step the way GitHub does and run it before the outcome.

// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const EXPRESSION_OPEN = ["$", "{{"].join("");
const expression = (value: string) => `${EXPRESSION_OPEN} ${value} }}`;

export const NEEDS_EXPRESSION = expression("toJSON(needs)");
export const PLAN_EXPRESSION = expression("toJSON(needs.ci-plan.outputs)");

/** GitHub's limit on one expression, which a string embedding one becomes. */
export const GITHUB_EXPRESSION_LIMIT = 21_000;

/** Whether a workflow string embeds an expression. */
export const embedsExpression = (value: string): boolean =>
  value.includes(EXPRESSION_OPEN);

export const RESULT_INPUTS_STEP = "Write CI outcome inputs";
const NEEDS_FILE = '"$RUNNER_TEMP/ci-result-needs.json"';
const PLAN_FILE = '"$RUNNER_TEMP/ci-result-plan.json"';

/** The inputs step's script, exactly as ci.yml declares it. */
export const RESULT_INPUTS_RUN = [
  `cat > ${NEEDS_FILE} <<'CI_RESULT_NEEDS_JSON'`,
  NEEDS_EXPRESSION,
  "CI_RESULT_NEEDS_JSON",
  `cat > ${PLAN_FILE} <<'CI_RESULT_PLAN_JSON'`,
  PLAN_EXPRESSION,
  "CI_RESULT_PLAN_JSON",
  "",
].join("\n");

/** The inputs step then the outcome script, as GitHub runs them for these job results and plan outputs. */
export const renderResultInputs = (
  run: string,
  inputs: { needs: string; plan: string },
): string => {
  if (
    run.includes(EXPRESSION_OPEN) ||
    !run.includes(NEEDS_FILE) ||
    !run.includes(PLAN_FILE)
  ) {
    return panic(
      "the outcome script must read its inputs from the inputs step's files and embed no expression",
    );
  }
  const inputsStep = RESULT_INPUTS_RUN.replace(
    NEEDS_EXPRESSION,
    () => inputs.needs,
  ).replace(PLAN_EXPRESSION, () => inputs.plan);
  return `RUNNER_TEMP=$(mktemp -d)\n${inputsStep}${run}`;
};
