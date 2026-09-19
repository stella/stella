/**
 * The question an AI-decided boolean template condition asks.
 *
 * Two boundaries ask it: the fill itself (`buildAiConditionDecider`, one
 * condition at a time, as the fill reaches it) and the fill form, which asks
 * for every condition of a template at once so the answer is visible and
 * overridable before the document is generated. Both must ask the same thing,
 * or the form shows a decision the fill does not take, so the wording, the
 * criteria and the decision id live here and nowhere else.
 *
 * Pure: no model, no provider, no org config.
 */

import { noul } from "@/api/lib/workflow/decisions/system-one";
import type { NoulQuestion } from "@/api/lib/workflow/decisions/system-one";

/** Stable decision name both boundaries log and replay under. */
export const CONDITION_DECISION_ID = "template.condition";

/** What each side means; shared so the two forms below cannot drift apart. */
const CONDITION_CRITERIA = {
  true: "The details state the condition or entail it.",
  false:
    "The details state that it does not hold, or do not settle it: an unsettled condition excludes its block.",
} as const;

/** One condition over its own state: the prompt rides in `state.question`. */
export const CONDITION_QUESTION = noul(
  {
    task: "Is the condition asked in `question` true for the document described by `details`?",
  },
  CONDITION_CRITERIA,
);

/**
 * One condition among several sharing a state: the prompt rides in the
 * question's own instructions, because a shared state can carry the values
 * once but not one `question` per condition.
 */
export const conditionQuestion = (prompt: string): NoulQuestion =>
  noul(
    {
      task: "Is the condition in `condition` true for the document described by `details`?",
      condition: prompt,
    },
    CONDITION_CRITERIA,
  );

type ConditionValues = Record<string, unknown>;

/** The values as the model reads them, serialized identically on both paths. */
const conditionDetails = (values: ConditionValues): string =>
  JSON.stringify(values);

/** State for {@link CONDITION_QUESTION}: one condition, one set of values. */
export const conditionState = ({
  prompt,
  values,
}: {
  prompt: string;
  values: ConditionValues;
}) => ({ question: prompt, details: conditionDetails(values) });

/** State for {@link conditionQuestion}: the values once, for every condition. */
export const conditionsState = (values: ConditionValues) => ({
  details: conditionDetails(values),
});
