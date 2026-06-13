import type {
  CompareOp,
  ConditionNode,
  GroupNode,
  PredicateOp,
  RefOperand,
} from "@stll/conditions";

import type { TranslationKey } from "@/i18n/types";

/**
 * Context-agnostic description of one operand the builder may filter
 * on. `valueType` drives both the operator set (`operatorsFor`) and
 * the value editor; `options` supplies the choices for any select-like
 * value type.
 */
export type FieldValueType =
  | "text"
  | "single-select"
  | "multi-select"
  | "date"
  | "int"
  | "kind"
  | "status"
  | "priority";

export type FieldOptionChoice = {
  value: string;
  label: string;
  color?: string;
};

export type FieldOption = {
  operand: RefOperand;
  label: string;
  valueType: FieldValueType;
  options?: FieldOptionChoice[];
};

/**
 * The surface operators the builder exposes. A subset maps to
 * `compare` nodes (binary comparisons against a literal); the rest map
 * to `predicate` nodes. `operatorKind` is the single place that
 * decides which AST node each operator builds.
 */
export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "contains_all",
  "in",
  "gt",
  "lt",
  "gte",
  "lte",
  "is_empty",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

const CONDITION_OPERATOR_SET: ReadonlySet<string> = new Set(
  CONDITION_OPERATORS,
);

export const isConditionOperator = (
  value: string,
): value is ConditionOperator => CONDITION_OPERATOR_SET.has(value);

const COMPARE_OPERATORS = ["eq", "neq", "gt", "lt", "gte", "lte"] as const;

type CompareOperator = (typeof COMPARE_OPERATORS)[number];

const isCompareOperator = (op: ConditionOperator): op is CompareOperator =>
  op === "eq" ||
  op === "neq" ||
  op === "gt" ||
  op === "lt" ||
  op === "gte" ||
  op === "lte";

export const OPERATOR_LABEL_KEYS = {
  eq: "filters.eq",
  neq: "filters.neq",
  contains: "filters.contains",
  contains_all: "filters.contains_all",
  in: "filters.in",
  gt: "filters.gt",
  lt: "filters.lt",
  gte: "filters.gte",
  lte: "filters.lte",
  is_empty: "filters.is_empty",
} as const satisfies Record<ConditionOperator, TranslationKey>;

/**
 * Single source of truth mapping a field's value type to the operators
 * the builder offers for it. Order here is the order rendered in the
 * operator Select.
 */
const OPERATORS_BY_VALUE_TYPE = {
  text: ["eq", "neq", "contains", "is_empty"],
  "single-select": ["eq", "neq", "contains", "is_empty"],
  status: ["eq", "neq", "contains", "is_empty"],
  priority: ["eq", "neq", "contains", "is_empty"],
  "multi-select": ["contains_all", "is_empty"],
  int: ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty"],
  date: ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty"],
  kind: ["in"],
} as const satisfies Record<FieldValueType, readonly ConditionOperator[]>;

export const operatorsFor = (
  valueType: FieldValueType,
): readonly ConditionOperator[] => OPERATORS_BY_VALUE_TYPE[valueType];

/** How a value type renders its value editor. */
export type ValueEditorKind = "none" | "text" | "int" | "date" | "select";

export const valueEditorFor = (
  valueType: FieldValueType,
  operator: ConditionOperator,
): ValueEditorKind => {
  if (operator === "is_empty") {
    return "none";
  }
  if (
    valueType === "single-select" ||
    valueType === "multi-select" ||
    valueType === "status" ||
    valueType === "priority" ||
    valueType === "kind"
  ) {
    return "select";
  }
  if (valueType === "int") {
    return "int";
  }
  if (valueType === "date") {
    return "date";
  }
  return "text";
};

/** Whether the value editor accepts multiple selections. */
export const isMultiValue = (operator: ConditionOperator): boolean =>
  operator === "contains_all" || operator === "in";

// ── Leaf identity ─────────────────────────────────────────

/** Compares two ref operands for the field-matching needed by the row. */
export const operandsEqual = (a: RefOperand, b: RefOperand): boolean => {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === "property" && b.type === "property") {
    return a.propertyId === b.propertyId;
  }
  if (a.type === "builtin" && b.type === "builtin") {
    return a.field === b.field;
  }
  // `kind` and `path` carry no further identity for `path`, but two
  // distinct path operands never coexist in a single builder context.
  return true;
};

/** Reads the ref operand a leaf node filters on, or null for a group. */
export const leafOperand = (node: ConditionNode): RefOperand | null => {
  if (node.type === "compare" && node.left.type !== "literal") {
    return node.left;
  }
  if (node.type === "predicate" && node.operand.type !== "literal") {
    return node.operand;
  }
  return null;
};

/** Reads the surface operator a leaf node represents. */
export const leafOperator = (node: ConditionNode): ConditionOperator | null => {
  if (node.type === "compare") {
    return compareToOperator(node.op);
  }
  if (node.type === "predicate") {
    return predicateToOperator(node.op);
  }
  return null;
};

const compareToOperator = (op: CompareOp): ConditionOperator => op;

const predicateToOperator = (op: PredicateOp): ConditionOperator | null => {
  if (
    op === "contains" ||
    op === "contains_all" ||
    op === "in" ||
    op === "is_empty"
  ) {
    return op;
  }
  return null;
};

/** Reads a leaf's value as a string (scalar editors). */
export const leafValueString = (node: ConditionNode): string => {
  if (node.type === "compare" && node.right.type === "literal") {
    const { value } = node.right;
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return String(value);
  }
  if (node.type === "predicate" && typeof node.value === "string") {
    return node.value;
  }
  return "";
};

/** Reads a leaf's value as a string list (multi editors). */
export const leafValueList = (node: ConditionNode): string[] => {
  if (node.type === "predicate" && Array.isArray(node.value)) {
    return node.value;
  }
  if (node.type === "predicate" && typeof node.value === "string") {
    return node.value === "" ? [] : [node.value];
  }
  return [];
};

// ── Leaf construction ─────────────────────────────────────

type BuildLeafArgs = {
  operand: RefOperand;
  operator: ConditionOperator;
  value: string | string[];
};

/**
 * Rebuilds a leaf node from its editor state. `compare` operators
 * produce a literal right operand; predicate operators carry their
 * payload (or none, for `is_empty`).
 */
export const buildLeaf = ({
  operand,
  operator,
  value,
}: BuildLeafArgs): ConditionNode => {
  if (isCompareOperator(operator)) {
    const scalar = Array.isArray(value) ? (value.at(0) ?? "") : value;
    return {
      type: "compare",
      left: operand,
      op: operator,
      right: { type: "literal", value: scalar },
    };
  }
  if (operator === "is_empty") {
    return { type: "predicate", operand, op: "is_empty" };
  }
  if (operator === "contains") {
    const scalar = Array.isArray(value) ? (value.at(0) ?? "") : value;
    return { type: "predicate", operand, op: "contains", value: scalar };
  }
  // contains_all | in — list payloads
  return { type: "predicate", operand, op: operator, value: toList(value) };
};

const toList = (value: string | string[]): string[] => {
  if (Array.isArray(value)) {
    return value;
  }
  return value === "" ? [] : [value];
};

/** A fresh leaf for a newly added row, with the field's first operator. */
export const leafFromField = (field: FieldOption): ConditionNode => {
  const operator = operatorsFor(field.valueType).at(0) ?? "eq";
  const value = isMultiValue(operator) ? [] : "";
  return buildLeaf({ operand: field.operand, operator, value });
};

// ── Group helpers ─────────────────────────────────────────

/** Normalizes the controlled `value` prop into a concrete group root. */
export const asGroup = (value: ConditionNode | null): GroupNode => {
  if (value && value.type === "group") {
    return value;
  }
  if (value) {
    return { type: "group", combinator: "and", children: [value] };
  }
  return { type: "group", combinator: "and", children: [] };
};

export const replaceChild = (
  group: GroupNode,
  index: number,
  child: ConditionNode,
): GroupNode => ({
  ...group,
  children: group.children.map((existing, i) =>
    i === index ? child : existing,
  ),
});

export const removeChild = (group: GroupNode, index: number): GroupNode => ({
  ...group,
  children: group.children.filter((_, i) => i !== index),
});

export const appendChild = (
  group: GroupNode,
  child: ConditionNode,
): GroupNode => ({
  ...group,
  children: [...group.children, child],
});
