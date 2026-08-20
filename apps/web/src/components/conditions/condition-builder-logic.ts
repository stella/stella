/**
 * Which message key each operator reads under, and the two value types that
 * relabel some of them.
 *
 * The builder itself takes resolved strings; these keys are the app's, and
 * `satisfies Record<..., TranslationKey>` is what proves every one of them
 * exists in the catalogue. The rest of the builder's logic lives in
 * `@stll/workspace-ui/conditions`, which this module re-exports so no call site
 * has to move.
 */

import type {
  ConditionOperator,
  FieldValueType,
} from "@stll/workspace-ui/conditions";

import type { TranslationKey } from "@/i18n/types";

export const OPERATOR_LABEL_KEYS = {
  eq: "filters.eq",
  neq: "filters.neq",
  contains: "filters.contains",
  not_contains: "filters.not_contains",
  starts_with: "filters.starts_with",
  ends_with: "filters.ends_with",
  contains_all: "filters.contains_all",
  in: "filters.in",
  gt: "filters.gt",
  lt: "filters.lt",
  gte: "filters.gte",
  lte: "filters.lte",
  is_empty: "filters.is_empty",
  is_not_empty: "filters.is_not_empty",
} as const satisfies Record<ConditionOperator, TranslationKey>;

/**
 * Per-value-type label overrides. Notion renders numeric and date
 * comparisons differently from the generic "is greater than" wording:
 * numbers use math symbols, dates use temporal phrasing.
 */
const INT_OPERATOR_LABEL_KEYS = {
  eq: "filters.numEq",
  neq: "filters.numNeq",
  contains: null,
  not_contains: null,
  starts_with: null,
  ends_with: null,
  contains_all: null,
  in: null,
  gt: "filters.numGt",
  lt: "filters.numLt",
  gte: "filters.numGte",
  lte: "filters.numLte",
  is_empty: null,
  is_not_empty: null,
} as const satisfies Record<ConditionOperator, TranslationKey | null>;

const DATE_OPERATOR_LABEL_KEYS = {
  eq: null,
  neq: null,
  contains: null,
  not_contains: null,
  starts_with: null,
  ends_with: null,
  contains_all: null,
  in: null,
  gt: "filters.dateAfter",
  lt: "filters.dateBefore",
  gte: "filters.dateOnOrAfter",
  lte: "filters.dateOnOrBefore",
  is_empty: null,
  is_not_empty: null,
} as const satisfies Record<ConditionOperator, TranslationKey | null>;

/**
 * The exact label keys an operator may resolve to, derived from the maps
 * above — not the full `TranslationKey` nor every `filters.*` key (some of
 * which carry ICU params), so `t()` accepts a single argument. `null` is an
 * absent per-value-type override (see `INT_`/`DATE_OPERATOR_LABEL_KEYS`), not
 * a resolvable label, so it is excluded here; `labelFrom` always falls back
 * to `OPERATOR_LABEL_KEYS` before returning.
 */
type OperatorLabelKey = Exclude<
  | (typeof OPERATOR_LABEL_KEYS)[keyof typeof OPERATOR_LABEL_KEYS]
  | (typeof INT_OPERATOR_LABEL_KEYS)[keyof typeof INT_OPERATOR_LABEL_KEYS]
  | (typeof DATE_OPERATOR_LABEL_KEYS)[keyof typeof DATE_OPERATOR_LABEL_KEYS],
  null
>;

const labelFrom = (
  overrides: Record<ConditionOperator, OperatorLabelKey | null>,
  operator: ConditionOperator,
): OperatorLabelKey => overrides[operator] ?? OPERATOR_LABEL_KEYS[operator];

export const operatorLabelKey = (
  valueType: FieldValueType,
  operator: ConditionOperator,
): OperatorLabelKey => {
  if (valueType === "int" || valueType === "money") {
    return labelFrom(INT_OPERATOR_LABEL_KEYS, operator);
  }
  if (valueType === "date") {
    return labelFrom(DATE_OPERATOR_LABEL_KEYS, operator);
  }
  return OPERATOR_LABEL_KEYS[operator];
};

export type {
  ConditionOperator,
  FieldOption,
  FieldOptionChoice,
  FieldValueType,
  ValueEditorKind,
} from "@stll/workspace-ui/conditions";
export {
  appendChild,
  asGroup,
  buildLeaf,
  CONDITION_OPERATORS,
  fieldForNode,
  isConditionOperator,
  isMultiValue,
  leafFromField,
  leafOperand,
  leafOperator,
  leafValueList,
  leafValueString,
  operandsEqual,
  operatorsFor,
  removeChild,
  replaceChild,
  valueEditorFor,
} from "@stll/workspace-ui/conditions";
