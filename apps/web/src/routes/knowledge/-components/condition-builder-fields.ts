import type { GroupNode } from "@stll/template-conditions";

/** The subset of a template field the rule builder needs to render a typed
 *  row. `inputType` drives the operator set and value control; `options` feed
 *  a select's value dropdown. Built by the caller from its richer field model;
 *  boolean fields are the yes/no question path and are excluded upstream. */
export type RuleField = {
  path: string;
  label: string;
  inputType: "text" | "textarea" | "number" | "date" | "select";
  options: readonly string[];
};

export type RuleInputType = RuleField["inputType"];

/** Source field shape both callers already have. Boolean fields are the yes/no
 *  question path and are dropped here, so the rule builder never offers them. */
type SourceField = {
  path: string;
  label: string;
  inputType: RuleInputType | "boolean";
  options: readonly string[];
};

const isRuleField = (
  field: SourceField,
): field is SourceField & { inputType: RuleInputType } =>
  field.inputType !== "boolean";

/** Project a caller's editable fields onto the rule builder's `RuleField`
 *  shape, excluding boolean (question) fields. */
export const toRuleFields = (
  fields: readonly SourceField[],
): readonly RuleField[] => {
  const result: RuleField[] = [];
  for (const f of fields) {
    if (!isRuleField(f)) {
      continue;
    }
    result.push({
      path: f.path,
      label: f.label,
      inputType: f.inputType,
      options: f.options,
    });
  }
  return result;
};

/** A fresh rule group. The shared builder renders existing children and only
 *  adds rows on user action, so callers that need a seeded row must add it
 *  before passing the group in. */
export const emptyGroup = (): GroupNode => ({
  type: "group",
  combinator: "and",
  children: [],
});
