import type { GroupNode } from "@stll/template-conditions";

import {
  ConditionBuilder,
  type ConditionCapabilities,
} from "@/components/conditions/condition-builder";
import type {
  ConditionOperator,
  FieldOption,
  FieldValueType,
  ValueEditorKind,
} from "@/components/conditions/condition-builder-logic";
import type { TranslationKey } from "@/i18n/types";

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

type RuleInputType = RuleField["inputType"];

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
): readonly RuleField[] =>
  fields.filter(isRuleField).map((f) => ({
    path: f.path,
    label: f.label,
    inputType: f.inputType,
    options: f.options,
  }));

/** A fresh, empty rule group. The shared builder seeds its own first row, so an
 *  empty `children` list is the canonical starting point. */
export const emptyGroup = (): GroupNode => ({
  type: "group",
  combinator: "and",
  children: [],
});

// ── RuleField → shared FieldOption mapping ────────────────
// The template surface targets `path` operands. `inputType` maps to the shared
// builder's `valueType`, which drives the (restricted) operator set and value
// editor below.

/** The four value types a template input can take. Narrower than the shared
 *  `FieldValueType` so the `type` (content-type) mapping stays exhaustive
 *  without a cast. */
type TemplateValueType = "text" | "int" | "date" | "single-select";

const VALUE_TYPE_BY_INPUT: Record<RuleInputType, TemplateValueType> = {
  text: "text",
  textarea: "text",
  number: "int",
  date: "date",
  select: "single-select",
};

const CONTENT_TYPE_BY_VALUE_TYPE: Record<
  TemplateValueType,
  FieldOption["type"]
> = {
  text: "text",
  int: "int",
  date: "date",
  "single-select": "single-select",
};

const toFieldOption = (field: RuleField): FieldOption => {
  const valueType = VALUE_TYPE_BY_INPUT[field.inputType];
  const base: FieldOption = {
    operand: { type: "path", path: field.path },
    label: field.label || field.path,
    valueType,
    type: CONTENT_TYPE_BY_VALUE_TYPE[valueType],
  };
  if (field.inputType !== "select") {
    return base;
  }
  return {
    ...base,
    options: field.options.map((value) => ({ value, label: value })),
  };
};

// ── Restricted operator profile ──────────────────────────
// `serializeCondition` only renders ==,!=,>,<,>=,<=,contains, so the template
// surface exposes exactly the operators those map to (eq/neq/gt/lt/gte/lte and
// contains), per value type, with friendly wording. The shared formula leaf
// runs through the "int" value type, so the int branch also covers formulas.

const TEMPLATE_OPERATORS = {
  text: ["eq", "neq", "contains"],
  "single-select": ["eq", "neq", "contains"],
  int: ["eq", "neq", "gt", "lt", "gte", "lte"],
  // Preserve the template's date ordering: before, on-or-before, on,
  // on-or-after, after.
  date: ["lt", "lte", "eq", "gte", "gt"],
  // The remaining value types never reach the template surface; fall back to
  // the safe serializable set.
  "multi-select": ["eq", "neq", "contains"],
  kind: ["eq", "neq", "contains"],
  status: ["eq", "neq", "contains"],
  priority: ["eq", "neq", "contains"],
} as const satisfies Record<FieldValueType, readonly ConditionOperator[]>;

const templateOperatorsFor = (
  valueType: FieldValueType,
): readonly ConditionOperator[] => TEMPLATE_OPERATORS[valueType];

// Friendly per-type operator labels, reproducing the template's prior wording.
// All are parameter-less keys so `t(key)` stays callable with one argument.
type TemplateOperatorLabelKey = Extract<
  TranslationKey,
  | "templates.conditionOpIs"
  | "templates.conditionOpIsNot"
  | "templates.conditionOpContains"
  | "templates.conditionOpEquals"
  | "templates.conditionOpNotEquals"
  | "templates.conditionOpGreaterThan"
  | "templates.conditionOpLessThan"
  | "templates.conditionOpAtLeast"
  | "templates.conditionOpAtMost"
  | "templates.conditionOpBefore"
  | "templates.conditionOpOnOrBefore"
  | "templates.conditionOpOn"
  | "templates.conditionOpOnOrAfter"
  | "templates.conditionOpAfter"
>;

type OperatorLabelMap = Partial<
  Record<ConditionOperator, TemplateOperatorLabelKey>
>;

const TEXT_OPERATOR_LABELS: OperatorLabelMap = {
  eq: "templates.conditionOpIs",
  neq: "templates.conditionOpIsNot",
  contains: "templates.conditionOpContains",
};

const NUMBER_OPERATOR_LABELS: OperatorLabelMap = {
  eq: "templates.conditionOpEquals",
  neq: "templates.conditionOpNotEquals",
  gt: "templates.conditionOpGreaterThan",
  lt: "templates.conditionOpLessThan",
  gte: "templates.conditionOpAtLeast",
  lte: "templates.conditionOpAtMost",
};

const DATE_OPERATOR_LABELS: OperatorLabelMap = {
  lt: "templates.conditionOpBefore",
  lte: "templates.conditionOpOnOrBefore",
  eq: "templates.conditionOpOn",
  gte: "templates.conditionOpOnOrAfter",
  gt: "templates.conditionOpAfter",
};

const templateOperatorLabelKey = (
  valueType: FieldValueType,
  op: ConditionOperator,
): TemplateOperatorLabelKey => {
  if (valueType === "int") {
    return NUMBER_OPERATOR_LABELS[op] ?? "templates.conditionOpEquals";
  }
  if (valueType === "date") {
    return DATE_OPERATOR_LABELS[op] ?? "templates.conditionOpOn";
  }
  return TEXT_OPERATOR_LABELS[op] ?? "templates.conditionOpIs";
};

// The template surface never uses the multi-value select editors, so each value
// type maps to the matching scalar editor the shared builder already provides.
const templateValueEditorFor = (valueType: FieldValueType): ValueEditorKind => {
  if (valueType === "int") {
    return "int";
  }
  if (valueType === "date") {
    return "date";
  }
  if (valueType === "single-select") {
    return "select";
  }
  return "text";
};

// ── Thin adapter over the shared ConditionBuilder ─────────

export const ConditionGroupEditor = ({
  fields,
  group,
  onChange,
}: {
  fields: readonly RuleField[];
  group: GroupNode;
  onChange: (group: GroupNode) => void;
}) => {
  const fieldOptions = fields.map(toFieldOption);
  const formulaNumberFields = fields
    .filter((f) => f.inputType === "number")
    .map((f) => ({ path: f.path, label: f.label || f.path }));

  const capabilities: ConditionCapabilities = {
    fields: fieldOptions,
    allowNesting: true,
    allowFormula: true,
    formulaNumberFields,
    addConditionLabel: "templates.conditionAddRule",
    operatorsFor: templateOperatorsFor,
    operatorLabelKey: templateOperatorLabelKey,
    valueEditorFor: templateValueEditorFor,
  };

  return (
    <ConditionBuilder
      capabilities={capabilities}
      onChange={onChange}
      value={group}
    />
  );
};
