/**
 * Resolve AI-decided boolean fields.
 *
 * A boolean manifest field with an `aiPrompt` is a yes/no question the model
 * answers at fill time (e.g. "Is this a consumer contract?"). Its value must be
 * a real boolean so the `{% if field_path %}` block that references it includes
 * or excludes its content correctly.
 *
 * Mirrors `resolveAiFields` (string drafts): this module stays free of any
 * model/provider dependency so it is pure and testable. The fill boundary
 * injects the decider (wired to the org's model); with no decider the field is
 * left unset, so the referencing `{% if %}` is falsy and the block is excluded —
 * the correct default. A value the user actually supplied always wins.
 *
 * Every condition it settles is reported back, with who settled it, so the fill
 * result can say what a document's gated blocks were decided on rather than
 * leaving an agent to infer it from the rendered text.
 */

import { evaluateCondition, resolvePath } from "@stll/template-conditions";

import type { DecisionUndecidedReason } from "../workflow/decisions/decide";
import { omitSourceBoundValues } from "./ai-visible-values";
import type { FieldMeta } from "./types";

/**
 * A field the model decides: a boolean whose `aiPrompt` is the yes/no question
 * it answers. The fill decides exactly these, and so does the fill form's
 * preview of them, which is why the two share this predicate instead of
 * mirroring it.
 */
export const isAiConditionField = (
  field: FieldMeta,
): field is FieldMeta & { aiPrompt: string } =>
  field.inputType === "boolean" &&
  field.aiPrompt !== undefined &&
  field.aiPrompt !== "";

/** How an AI-decided condition is shown: its label, or its path unlabelled.
 *  Shared with the fill form's preview so the two name the same condition
 *  identically. */
const aiConditionLabel = (field: FieldMeta): string =>
  field.label ?? field.path;

/**
 * What the decider settled, and on which tier. The decision model answers with
 * a probability; the generative fallback answers without one. `undefined` from
 * the decider still means "leave unset", so an unanswerable condition keeps
 * excluding its block.
 */
type AiConditionDecision =
  | { decidedBy: "decision_model"; value: boolean; probability: number }
  | { decidedBy: "generative_model"; value: boolean };

export type AiConditionDecider = (input: {
  prompt: string;
  fieldPath: string;
  /** Already-entered + previously-resolved values, for grounding the decision. */
  values: Record<string, unknown>;
}) => Promise<AiConditionDecision | undefined>;

/**
 * One AI-decided condition's outcome, per condition the manifest declares.
 * `user` is a value the caller supplied, which always wins over the model;
 * `undecided` is a condition no tier settled, whose block is therefore
 * excluded.
 */
export type ResolvedAiCondition = { path: string; label: string } & (
  | {
      state: "decided";
      value: boolean;
      decidedBy: "decision_model";
      probability: number;
    }
  | { state: "decided"; value: boolean; decidedBy: "generative_model" }
  | { state: "decided"; value: boolean; decidedBy: "user" }
  | { state: "undecided"; reason: DecisionUndecidedReason }
);

export type ResolvedAiConditions = {
  values: Record<string, unknown>;
  conditions: ResolvedAiCondition[];
};

export const resolveAiConditions = async ({
  values,
  fields,
  decide,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  decide: AiConditionDecider | undefined;
}): Promise<ResolvedAiConditions> => {
  const aiConditionFields = fields.filter(isAiConditionField);
  if (aiConditionFields.length === 0) {
    return { values, conditions: [] };
  }

  const resolved: Record<string, unknown> = { ...values };
  const conditions: ResolvedAiCondition[] = [];
  for (const field of aiConditionFields) {
    const label = aiConditionLabel(field);
    // The fill form nests dotted paths, so resolve the path rather than reading
    // the flat key — otherwise a nested user value is missed (same reasoning as
    // resolveAiFields).
    const existing = resolvePath(field.path, resolved);
    if (existing !== undefined && existing !== "") {
      conditions.push({
        path: field.path,
        label,
        state: "decided",
        // The boolean the `{% if field_path %}` block will read, evaluated by
        // the engine that renders it rather than by a second truthiness rule.
        value: evaluateCondition(field.path, resolved),
        decidedBy: "user",
      });
      continue; // user-entered value wins
    }
    if (decide === undefined) {
      conditions.push({
        path: field.path,
        label,
        state: "undecided",
        reason: "no-backend",
      });
      continue;
    }
    const decision = await decide({
      prompt: field.aiPrompt,
      fieldPath: field.path,
      values: omitSourceBoundValues({ values: resolved, fields }),
    });
    if (decision === undefined) {
      conditions.push({
        path: field.path,
        label,
        state: "undecided",
        reason: "failed",
      });
      continue;
    }
    resolved[field.path] = decision.value;
    conditions.push(
      decision.decidedBy === "decision_model"
        ? {
            path: field.path,
            label,
            state: "decided",
            value: decision.value,
            decidedBy: "decision_model",
            probability: decision.probability,
          }
        : {
            path: field.path,
            label,
            state: "decided",
            value: decision.value,
            decidedBy: "generative_model",
          },
    );
  }
  return { values: resolved, conditions };
};
