/**
 * The single in-memory evaluator for the condition AST. Domain
 * code supplies a `resolve` adapter that turns a non-literal
 * operand into a concrete value; everything else (operators,
 * boolean combination, negation) lives here so semantics never
 * drift between view filters, extraction gating, and templates.
 */
import type {
  CompareNode,
  CompareOp,
  ConditionNode,
  Operand,
  PredicateNode,
  RefOperand,
} from "./schema";

export type ConditionValue =
  | string
  | number
  | boolean
  | string[]
  | null
  | undefined;

export type OperandResolver = (operand: RefOperand) => ConditionValue;

export const evaluateCondition = (
  node: ConditionNode,
  resolve: OperandResolver,
): boolean => {
  switch (node.type) {
    case "group": {
      const evalChild = (child: ConditionNode) =>
        evaluateCondition(child, resolve);
      // Empty AND ⇒ true (matches all); empty OR ⇒ false.
      const combined =
        node.combinator === "and"
          ? node.children.every(evalChild)
          : node.children.some(evalChild);
      return node.negated ? !combined : combined;
    }
    case "compare":
      return evaluateCompare(node, resolve);
    case "predicate":
      return evaluatePredicate(node, resolve);
    default:
      return false;
  }
};

const resolveOperand = (
  operand: Operand,
  resolve: OperandResolver,
): ConditionValue => {
  if (operand.type === "literal") {
    return operand.value;
  }
  return resolve(operand);
};

// ── Comparisons ───────────────────────────────────────────

const evaluateCompare = (
  node: CompareNode,
  resolve: OperandResolver,
): boolean => {
  const left = resolveOperand(node.left, resolve);
  const right = resolveOperand(node.right, resolve);
  return compareValues(left, node.op, right);
};

/** Normalize for equality: nullish ⇒ "", arrays ⇒ comma-joined. */
const normScalar = (value: ConditionValue): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
};

const toNumber = (value: ConditionValue): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const compareValues = (
  left: ConditionValue,
  op: CompareOp,
  right: ConditionValue,
): boolean => {
  if (op === "eq") {
    return normScalar(left) === normScalar(right);
  }
  if (op === "neq") {
    return normScalar(left) !== normScalar(right);
  }

  // Numeric comparison when the right-hand value (the literal, in Table
  // filters) is a number: a non-numeric left value is then excluded. When the
  // right value is non-numeric — e.g. an ISO date string — compare
  // lexicographically so dates order chronologically, matching the SQL side.
  const rn = toNumber(right);
  if (rn !== undefined) {
    const ln = toNumber(left);
    if (ln === undefined) {
      return false;
    }
    if (op === "gt") {
      return ln > rn;
    }
    if (op === "lt") {
      return ln < rn;
    }
    if (op === "gte") {
      return ln >= rn;
    }
    return ln <= rn;
  }

  const ls = normScalar(left);
  const rs = normScalar(right);
  // A blank/absent value is not comparable: exclude it from ordered
  // comparisons (so "date is before X" never matches rows with no date),
  // mirroring the numeric branch's exclusion of non-numeric values.
  if (ls === "") {
    return false;
  }
  if (op === "gt") {
    return ls > rs;
  }
  if (op === "lt") {
    return ls < rs;
  }
  if (op === "gte") {
    return ls >= rs;
  }
  return ls <= rs;
};

// ── Predicates ────────────────────────────────────────────

const isTruthy = (value: ConditionValue): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  return value.length > 0;
};

const asArray = (value: ConditionValue): string[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined || value === "") {
    return [];
  }
  return [String(value)];
};

const evaluatePredicate = (
  node: PredicateNode,
  resolve: OperandResolver,
): boolean => {
  const actual = resolveOperand(node.operand, resolve);

  switch (node.op) {
    case "is_empty":
      return asArray(actual).length === 0;
    case "is_not_empty":
      return asArray(actual).length > 0;
    case "is_truthy":
      return isTruthy(actual);
    case "contains":
      return matchesContains(actual, node.value);
    case "not_contains":
      return !matchesContains(actual, node.value);
    case "starts_with":
      return normScalar(actual)
        .toLowerCase()
        .startsWith(String(node.value ?? "").toLowerCase());
    case "ends_with":
      return normScalar(actual)
        .toLowerCase()
        .endsWith(String(node.value ?? "").toLowerCase());
    case "contains_all": {
      const present = asArray(actual);
      return asArray(node.value).every((want) => present.includes(want));
    }
    case "in":
      return asArray(node.value).includes(normScalar(actual));
    default:
      return false;
  }
};

/** Substring match on a scalar, or membership on an array. */
const matchesContains = (
  actual: ConditionValue,
  value: string | string[] | undefined,
): boolean => {
  const needle = String(value ?? "").toLowerCase();
  if (Array.isArray(actual)) {
    return actual.some((item) => item.toLowerCase() === needle);
  }
  return normScalar(actual).toLowerCase().includes(needle);
};
