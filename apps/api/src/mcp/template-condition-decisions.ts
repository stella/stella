/**
 * The one agent-facing shape for "what was decided about a template's gated
 * blocks".
 *
 * Two tools report it: `fill_template`, for the conditions a fill actually
 * settled, and `preview_template_conditions`, for what the decision model says
 * a set of values would settle before anything is filled. They are the same
 * question asked at two moments, so they are one schema and one mapper here
 * rather than two that drift: an agent that learned to read one reads the
 * other.
 *
 * A condition is either decided — with the tier that decided it and, for the
 * decision model, the probability it chose that side with — or undecided for
 * one of a closed set of reasons. Undecided is never reported as `false`: an
 * undecided block is excluded, but so is a block decided `false`, and an agent
 * retrying needs to tell the two apart.
 */

import { panic } from "better-result";
import * as v from "valibot";

import { DECISION_UNDECIDED_REASON_CODES } from "@stll/api-contract/ai-decision-provider";

import type { ResolvedAiCondition } from "@/api/lib/docx/resolve-ai-conditions";
import type { TemplateConditionAnswer } from "@/api/lib/templates/template-decide-conditions";

const TEMPLATE_CONDITION_DECISION_MODEL_OUTPUT_SCHEMA = v.strictObject({
  path: v.string(),
  label: v.string(),
  state: v.literal("decided"),
  value: v.boolean(),
  decided_by: v.literal("decision_model"),
  /** Probability of the side chosen, not of yes. */
  probability: v.number(),
});

const TEMPLATE_CONDITION_NON_MODEL_OUTPUT_SCHEMA = v.strictObject({
  path: v.string(),
  label: v.string(),
  state: v.literal("decided"),
  value: v.boolean(),
  decided_by: v.picklist(["generative_model", "user"]),
});

/** A condition no tier settled. The fill renders it as if false, so it is
 *  reported, and graded as a shortfall, rather than shown as `false`. */
export const TEMPLATE_UNDECIDED_CONDITION_OUTPUT_SCHEMA = v.strictObject({
  path: v.string(),
  label: v.string(),
  state: v.literal("undecided"),
  reason: v.picklist(Object.values(DECISION_UNDECIDED_REASON_CODES)),
});

export const TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA = v.union([
  TEMPLATE_CONDITION_DECISION_MODEL_OUTPUT_SCHEMA,
  TEMPLATE_CONDITION_NON_MODEL_OUTPUT_SCHEMA,
  TEMPLATE_UNDECIDED_CONDITION_OUTPUT_SCHEMA,
]);

export type TemplateConditionDecisionOutput = v.InferInput<
  typeof TEMPLATE_CONDITION_DECISION_OUTPUT_SCHEMA
>;

type TemplateUndecidedConditionOutput = v.InferInput<
  typeof TEMPLATE_UNDECIDED_CONDITION_OUTPUT_SCHEMA
>;

/** A condition the fill settled (or could not), as the tool reports it. */
export const toFillConditionDecision = (
  condition: ResolvedAiCondition,
): TemplateConditionDecisionOutput => {
  switch (condition.state) {
    case "decided":
      switch (condition.decidedBy) {
        case "decision_model":
          return {
            path: condition.path,
            label: condition.label,
            state: "decided",
            value: condition.value,
            decided_by: "decision_model",
            probability: condition.probability,
          };
        case "generative_model":
        case "user":
          return {
            path: condition.path,
            label: condition.label,
            state: "decided",
            value: condition.value,
            decided_by: condition.decidedBy,
          };
        default:
          condition satisfies never;
          return panic("Unhandled resolved condition decision source");
      }
    case "undecided":
      return toUndecidedConditionOutput(condition);
    default:
      condition satisfies never;
      return panic("Unhandled resolved condition state");
  }
};

/** An undecided condition as the tools report it. */
export const toUndecidedConditionOutput = (
  condition: Extract<ResolvedAiCondition, { state: "undecided" }>,
): TemplateUndecidedConditionOutput => ({
  path: condition.path,
  label: condition.label,
  state: "undecided",
  reason: DECISION_UNDECIDED_REASON_CODES[condition.reason],
});

/** A condition previewed without filling anything. The generative fallback
 *  never runs here; a decided answer comes from the supplied values or the
 *  decision model. */
export const toPreviewConditionDecision = ({
  path,
  label,
  decision,
}: TemplateConditionAnswer): TemplateConditionDecisionOutput => {
  switch (decision.state) {
    case "decided":
      return decision.decidedBy === "user"
        ? {
            path,
            label,
            state: "decided",
            value: decision.value,
            decided_by: "user",
          }
        : {
            path,
            label,
            state: "decided",
            value: decision.value,
            decided_by: "decision_model",
            probability: decision.probability,
          };
    case "undecided":
      return {
        path,
        label,
        state: "undecided",
        reason: DECISION_UNDECIDED_REASON_CODES[decision.reason],
      };
    default:
      decision satisfies never;
      return panic("Unhandled template condition decision state");
  }
};
