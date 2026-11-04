/**
 * Formula expressions: arithmetic, dates, comparisons, conditionals and
 * cross-row aggregates over a table's columns, as a structured AST.
 *
 * It composes with the condition AST rather than competing with it: an
 * `if` may test any `ConditionNode` (the same one view filters and playbook
 * gates use), and comparisons between computed values are expression nodes
 * of their own. There is no text syntax and nothing is ever executed as
 * code; the evaluator is a pure function of the expression, the row, the
 * column values it aggregates over, and the date it is told is today.
 */
import { panic } from "better-result";
import * as v from "valibot";

import { evaluateCondition } from "./evaluate";
import type { OperandResolver } from "./evaluate";
import { COMPARE_OPS, conditionNodeSchema } from "./schema";
import type { CompareOp, ConditionNode } from "./schema";

export const ARITHMETIC_OPS = [
  "add",
  "sub",
  "mul",
  "div",
  "min",
  "max",
] as const;
export type ArithmeticOp = (typeof ARITHMETIC_OPS)[number];

export const UNARY_OPS = ["neg", "abs"] as const;
export type UnaryOp = (typeof UNARY_OPS)[number];

export const AGGREGATE_FNS = [
  "min",
  "max",
  "sum",
  "avg",
  "count",
  "rank_asc",
  "rank_desc",
  "share_of_total",
] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export const LOGIC_OPS = ["and", "or"] as const;
export type LogicOp = (typeof LOGIC_OPS)[number];

/** Expressions nest at most this deep; a deeper one is refused at the boundary. */
export const EXPRESSION_MAX_DEPTH = 12;
/** And hold at most this many nodes. */
export const EXPRESSION_MAX_NODES = 200;
const ROUND_MAX_DIGITS = 6;

export type Expression =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "money"; amountCents: number; currency: string }
  | { type: "empty" }
  | { type: "field"; propertyId: string }
  | { type: "today" }
  | {
      type: "arithmetic";
      op: ArithmeticOp;
      left: Expression;
      right: Expression;
    }
  | { type: "unary"; op: UnaryOp; arg: Expression }
  | { type: "round"; arg: Expression; digits: number }
  | { type: "days_between"; from: Expression; to: Expression }
  | { type: "add_days"; date: Expression; days: Expression }
  | { type: "compare"; op: CompareOp; left: Expression; right: Expression }
  | { type: "logic"; op: LogicOp; args: Expression[] }
  | { type: "not"; arg: Expression }
  | { type: "is_empty"; arg: Expression }
  | { type: "condition"; node: ConditionNode }
  | { type: "if"; when: Expression; ifTrue: Expression; ifFalse: Expression }
  | { type: "coalesce"; args: Expression[] }
  | { type: "aggregate"; fn: AggregateFn; propertyId: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const currencyCode = v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u));
const propertyId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const expression = (): v.GenericSchema<Expression> => expressionSchema;
const lazyExpression = v.lazy(expression);

const expressionVariant: v.GenericSchema<Expression> = v.variant("type", [
  v.strictObject({
    type: v.literal("number"),
    value: v.pipe(v.number(), v.finite()),
  }),
  v.strictObject({
    type: v.literal("text"),
    value: v.pipe(v.string(), v.maxLength(1000)),
  }),
  v.strictObject({
    type: v.literal("date"),
    value: v.pipe(v.string(), v.regex(ISO_DATE)),
  }),
  v.strictObject({ type: v.literal("boolean"), value: v.boolean() }),
  v.strictObject({
    type: v.literal("money"),
    amountCents: v.pipe(v.number(), v.safeInteger()),
    currency: currencyCode,
  }),
  v.strictObject({ type: v.literal("empty") }),
  v.strictObject({ type: v.literal("field"), propertyId }),
  v.strictObject({ type: v.literal("today") }),
  v.strictObject({
    type: v.literal("arithmetic"),
    op: v.picklist(ARITHMETIC_OPS),
    left: lazyExpression,
    right: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("unary"),
    op: v.picklist(UNARY_OPS),
    arg: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("round"),
    arg: lazyExpression,
    digits: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(ROUND_MAX_DIGITS),
    ),
  }),
  v.strictObject({
    type: v.literal("days_between"),
    from: lazyExpression,
    to: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("add_days"),
    date: lazyExpression,
    days: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("compare"),
    op: v.picklist(COMPARE_OPS),
    left: lazyExpression,
    right: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("logic"),
    op: v.picklist(LOGIC_OPS),
    args: v.pipe(v.array(lazyExpression), v.minLength(1), v.maxLength(20)),
  }),
  v.strictObject({ type: v.literal("not"), arg: lazyExpression }),
  v.strictObject({ type: v.literal("is_empty"), arg: lazyExpression }),
  v.strictObject({ type: v.literal("condition"), node: conditionNodeSchema }),
  v.strictObject({
    type: v.literal("if"),
    when: lazyExpression,
    ifTrue: lazyExpression,
    ifFalse: lazyExpression,
  }),
  v.strictObject({
    type: v.literal("coalesce"),
    args: v.pipe(v.array(lazyExpression), v.minLength(1), v.maxLength(20)),
  }),
  v.strictObject({
    type: v.literal("aggregate"),
    fn: v.picklist(AGGREGATE_FNS),
    propertyId,
  }),
]);

/** Children of a node, for the size checks and for listing referenced columns. */
const childrenOf = (node: Expression): Expression[] => {
  switch (node.type) {
    case "arithmetic":
    case "compare":
      return [node.left, node.right];
    case "unary":
    case "round":
    case "not":
    case "is_empty":
      return [node.arg];
    case "days_between":
      return [node.from, node.to];
    case "add_days":
      return [node.date, node.days];
    case "logic":
    case "coalesce":
      return node.args;
    case "if":
      return [node.when, node.ifTrue, node.ifFalse];
    case "number":
    case "text":
    case "date":
    case "boolean":
    case "money":
    case "empty":
    case "field":
    case "today":
    case "condition":
    case "aggregate":
      return [];
    default:
      node satisfies never;
      return panic("Unhandled expression node");
  }
};

type ExpressionSize = { depth: number; nodes: number };

const measure = (node: Expression): ExpressionSize => {
  let nodes = 1;
  let depth = 0;
  for (const child of childrenOf(node)) {
    const size = measure(child);
    nodes += size.nodes;
    depth = Math.max(depth, size.depth);
  }
  return { depth: depth + 1, nodes };
};

/** The boundary schema: a well-formed expression within the size limits. */
export const expressionSchema: v.GenericSchema<Expression> = v.pipe(
  expressionVariant,
  v.check((node) => {
    const { depth, nodes } = measure(node);
    return depth <= EXPRESSION_MAX_DEPTH && nodes <= EXPRESSION_MAX_NODES;
  }, `A formula may nest ${EXPRESSION_MAX_DEPTH} levels and hold ${EXPRESSION_MAX_NODES} nodes`),
);

/** Every column an expression reads, row values and aggregates alike. */
export const expressionPropertyIds = (node: Expression): Set<string> => {
  const ids = new Set<string>();
  const visit = (current: Expression) => {
    if (current.type === "field" || current.type === "aggregate") {
      ids.add(current.propertyId);
    }
    for (const child of childrenOf(current)) {
      visit(child);
    }
  };
  visit(node);
  return ids;
};

// ── Values ────────────────────────────────────────────────

export type FormulaValue =
  | { type: "empty" }
  | { type: "number"; value: number }
  | { type: "money"; amountCents: number; currency: string }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean };

export const FORMULA_ERROR_CODES = [
  "type_mismatch",
  "division_by_zero",
  "mixed_currencies",
  "out_of_range",
  "invalid_date",
] as const;
export type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number];

/** A formula that cannot produce a value names why, never a NaN or a guess. */
export type FormulaError = { type: "error"; code: FormulaErrorCode };

export type FormulaResult = FormulaValue | FormulaError;

export type FormulaContext = {
  /** The row's value for a column; `empty` when the cell holds nothing. */
  field: (propertyId: string) => FormulaValue;
  /** Every row's value for a column, the row itself included, for aggregates. */
  column: (propertyId: string) => readonly FormulaValue[];
  /** The condition AST's adapter for embedded `condition` nodes. */
  resolveCondition: OperandResolver;
  /** ISO date the formula is evaluated on; recorded with the result. */
  today: string;
};

const EMPTY: FormulaValue = { type: "empty" };
const error = (code: FormulaErrorCode): FormulaError => ({
  type: "error",
  code,
});
const isError = (result: FormulaResult): result is FormulaError =>
  result.type === "error";

// Civil-date arithmetic on proleptic Gregorian day numbers (days since
// 1970-01-01), so the evaluator needs no Date and no time zone: a date is a
// calendar day, the same everywhere.
const daysFromCivil = (year: number, month: number, day: number): number => {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
};

const civilFromDays = (days: number): [number, number, number] => {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
};

const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");

const isoFromDayNumber = (days: number): string => {
  const [year, month, day] = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

/** The day number of an ISO calendar date; null for a non-date ("2026-02-30"). */
const dayNumber = (iso: string): number | null => {
  if (!ISO_DATE.test(iso)) {
    return null;
  }
  const [year, month, day] = iso.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const days = daysFromCivil(year, month, day);
  return isoFromDayNumber(days) === iso ? days : null;
};

const toNumberOrError = (value: number): FormulaResult =>
  Number.isFinite(value) ? { type: "number", value } : error("out_of_range");

const toMoneyOrError = (
  amountCents: number,
  currency: string,
): FormulaResult => {
  const rounded = Math.round(amountCents);
  return Number.isSafeInteger(rounded)
    ? { type: "money", amountCents: rounded, currency }
    : error("out_of_range");
};

const arithmetic = (
  op: ArithmeticOp,
  left: FormulaValue,
  right: FormulaValue,
): FormulaResult => {
  if (left.type === "empty" || right.type === "empty") {
    return EMPTY;
  }
  if (left.type === "number" && right.type === "number") {
    switch (op) {
      case "add":
        return toNumberOrError(left.value + right.value);
      case "sub":
        return toNumberOrError(left.value - right.value);
      case "mul":
        return toNumberOrError(left.value * right.value);
      case "div":
        return right.value === 0
          ? error("division_by_zero")
          : toNumberOrError(left.value / right.value);
      case "min":
        return { type: "number", value: Math.min(left.value, right.value) };
      case "max":
        return { type: "number", value: Math.max(left.value, right.value) };
      default:
        op satisfies never;
        return panic("Unhandled arithmetic operator");
    }
  }
  if (left.type === "money" && right.type === "money") {
    if (left.currency !== right.currency) {
      return error("mixed_currencies");
    }
    switch (op) {
      case "add":
        return toMoneyOrError(
          left.amountCents + right.amountCents,
          left.currency,
        );
      case "sub":
        return toMoneyOrError(
          left.amountCents - right.amountCents,
          left.currency,
        );
      case "div":
        // A ratio of two amounts in one currency is a plain number.
        return right.amountCents === 0
          ? error("division_by_zero")
          : toNumberOrError(left.amountCents / right.amountCents);
      case "min":
        return left.amountCents <= right.amountCents ? left : right;
      case "max":
        return left.amountCents >= right.amountCents ? left : right;
      case "mul":
        return error("type_mismatch");
      default:
        op satisfies never;
        return panic("Unhandled arithmetic operator");
    }
  }
  if (left.type === "money" && right.type === "number") {
    if (op === "mul") {
      return toMoneyOrError(left.amountCents * right.value, left.currency);
    }
    if (op === "div") {
      return right.value === 0
        ? error("division_by_zero")
        : toMoneyOrError(left.amountCents / right.value, left.currency);
    }
    return error("type_mismatch");
  }
  if (left.type === "number" && right.type === "money" && op === "mul") {
    return toMoneyOrError(left.value * right.amountCents, right.currency);
  }
  return error("type_mismatch");
};

/** Numbers, money of one currency, dates and texts order among their own kind. */
const orderKey = (
  value: FormulaValue,
): { kind: string; key: number | string } | null => {
  switch (value.type) {
    case "number":
      return { kind: "number", key: value.value };
    case "money":
      return { kind: `money:${value.currency}`, key: value.amountCents };
    case "date":
      return { kind: "date", key: value.value };
    case "text":
      return { kind: "text", key: value.value };
    case "boolean":
      return { kind: "boolean", key: value.value ? 1 : 0 };
    case "empty":
      return null;
    default:
      value satisfies never;
      return panic("Unhandled formula value");
  }
};

const compare = (
  op: CompareOp,
  left: FormulaValue,
  right: FormulaValue,
): FormulaResult => {
  const a = orderKey(left);
  const b = orderKey(right);
  if (a === null || b === null) {
    // Only equality is decidable against an empty value.
    if (op === "eq") {
      return { type: "boolean", value: a === null && b === null };
    }
    if (op === "neq") {
      return { type: "boolean", value: !(a === null && b === null) };
    }
    return EMPTY;
  }
  if (a.kind !== b.kind) {
    return a.kind.startsWith("money:") && b.kind.startsWith("money:")
      ? error("mixed_currencies")
      : error("type_mismatch");
  }
  let order = 0;
  if (a.key < b.key) {
    order = -1;
  } else if (a.key > b.key) {
    order = 1;
  }
  const results: Record<CompareOp, boolean> = {
    eq: order === 0,
    neq: order !== 0,
    gt: order > 0,
    lt: order < 0,
    gte: order >= 0,
    lte: order <= 0,
  };
  return { type: "boolean", value: results[op] };
};

const aggregate = (
  fn: AggregateFn,
  rowValue: FormulaValue,
  values: readonly FormulaValue[],
): FormulaResult => {
  const present = values.filter((value) => value.type !== "empty");
  if (fn === "count") {
    return { type: "number", value: present.length };
  }
  if (present.length === 0) {
    return EMPTY;
  }
  const keys = present.map(orderKey);
  const kinds = new Set(keys.map((key) => key?.kind));
  if (kinds.size > 1) {
    return [...kinds].every((kind) => kind?.startsWith("money:") === true)
      ? error("mixed_currencies")
      : error("type_mismatch");
  }
  const first = present[0];
  if (first === undefined) {
    return EMPTY;
  }
  const amount = (value: FormulaValue): number | null => {
    if (value.type === "number") {
      return value.value;
    }
    return value.type === "money" ? value.amountCents : null;
  };
  switch (fn) {
    case "min":
    case "max": {
      let best = first;
      for (const value of present) {
        const ordered = compare(fn === "min" ? "lt" : "gt", value, best);
        if (ordered.type === "boolean" && ordered.value) {
          best = value;
        }
      }
      return best;
    }
    case "rank_asc":
    case "rank_desc": {
      // Competition ranking (1, 2, 2, 4): ties share the better rank.
      const own = orderKey(rowValue);
      if (own === null) {
        return EMPTY;
      }
      const better = keys.filter(
        (key) =>
          key !== null &&
          (fn === "rank_asc" ? key.key < own.key : key.key > own.key),
      ).length;
      return { type: "number", value: better + 1 };
    }
    case "sum":
    case "avg":
    case "share_of_total": {
      const amounts = present.map(amount);
      if (amounts.some((value) => value === null)) {
        return error("type_mismatch");
      }
      const total = amounts.reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      );
      if (fn === "share_of_total") {
        const own = amount(rowValue);
        if (rowValue.type === "empty") {
          return EMPTY;
        }
        if (own === null) {
          return error("type_mismatch");
        }
        return total === 0
          ? error("division_by_zero")
          : toNumberOrError(own / total);
      }
      const result = fn === "sum" ? total : total / present.length;
      return first.type === "money"
        ? toMoneyOrError(result, first.currency)
        : toNumberOrError(result);
    }
    default:
      fn satisfies never;
      return panic("Unhandled aggregate");
  }
};

const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  // Half away from zero on the magnitude, so -2.5 rounds to -3 like 2.5 to 3.
  return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
};

type Evaluate = (node: Expression) => FormulaResult;

const evaluateUnary = (
  node: Extract<Expression, { type: "unary" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const arg = evaluate(node.arg);
  if (isError(arg) || arg.type === "empty") {
    return arg;
  }
  if (arg.type === "number") {
    return {
      type: "number",
      value: node.op === "neg" ? -arg.value : Math.abs(arg.value),
    };
  }
  if (arg.type === "money") {
    return {
      type: "money",
      amountCents:
        node.op === "neg" ? -arg.amountCents : Math.abs(arg.amountCents),
      currency: arg.currency,
    };
  }
  return error("type_mismatch");
};

const evaluateRound = (
  node: Extract<Expression, { type: "round" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const arg = evaluate(node.arg);
  if (isError(arg) || arg.type === "empty" || arg.type === "money") {
    return arg;
  }
  return arg.type === "number"
    ? { type: "number", value: roundTo(arg.value, node.digits) }
    : error("type_mismatch");
};

/** Both operands, or the first error or empty among them. */
const evaluatePair = (
  left: Expression,
  right: Expression,
  evaluate: Evaluate,
): [FormulaValue, FormulaValue] | FormulaResult => {
  const first = evaluate(left);
  if (isError(first)) {
    return first;
  }
  const second = evaluate(right);
  if (isError(second)) {
    return second;
  }
  return [first, second];
};

const evaluateDaysBetween = (
  node: Extract<Expression, { type: "days_between" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const pair = evaluatePair(node.from, node.to, evaluate);
  if (!Array.isArray(pair)) {
    return pair;
  }
  const [from, to] = pair;
  if (from.type === "empty" || to.type === "empty") {
    return EMPTY;
  }
  if (from.type !== "date" || to.type !== "date") {
    return error("type_mismatch");
  }
  const start = dayNumber(from.value);
  const end = dayNumber(to.value);
  return start === null || end === null
    ? error("invalid_date")
    : { type: "number", value: end - start };
};

const evaluateAddDays = (
  node: Extract<Expression, { type: "add_days" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const pair = evaluatePair(node.date, node.days, evaluate);
  if (!Array.isArray(pair)) {
    return pair;
  }
  const [date, days] = pair;
  if (date.type === "empty" || days.type === "empty") {
    return EMPTY;
  }
  if (date.type !== "date" || days.type !== "number") {
    return error("type_mismatch");
  }
  const start = dayNumber(date.value);
  if (start === null) {
    return error("invalid_date");
  }
  return Number.isInteger(days.value)
    ? { type: "date", value: isoFromDayNumber(start + days.value) }
    : error("type_mismatch");
};

const evaluateLogic = (
  node: Extract<Expression, { type: "logic" }>,
  evaluate: Evaluate,
): FormulaResult => {
  let sawEmpty = false;
  for (const child of node.args) {
    const result = evaluate(child);
    if (isError(result)) {
      return result;
    }
    if (result.type === "empty") {
      sawEmpty = true;
      continue;
    }
    if (result.type !== "boolean") {
      return error("type_mismatch");
    }
    // Short-circuit on the deciding value, as the condition AST does.
    if (result.value === (node.op === "or")) {
      return result;
    }
  }
  return sawEmpty ? EMPTY : { type: "boolean", value: node.op === "and" };
};

const evaluateNot = (
  node: Extract<Expression, { type: "not" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const arg = evaluate(node.arg);
  if (isError(arg) || arg.type === "empty") {
    return arg;
  }
  return arg.type === "boolean"
    ? { type: "boolean", value: !arg.value }
    : error("type_mismatch");
};

const evaluateIf = (
  node: Extract<Expression, { type: "if" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const when = evaluate(node.when);
  if (isError(when)) {
    return when;
  }
  if (when.type === "empty") {
    return evaluate(node.ifFalse);
  }
  if (when.type !== "boolean") {
    return error("type_mismatch");
  }
  return evaluate(when.value ? node.ifTrue : node.ifFalse);
};

const evaluateCoalesce = (
  node: Extract<Expression, { type: "coalesce" }>,
  evaluate: Evaluate,
): FormulaResult => {
  for (const child of node.args) {
    const result = evaluate(child);
    if (isError(result) || result.type !== "empty") {
      return result;
    }
  }
  return EMPTY;
};

const evaluateBinary = (
  node: Extract<Expression, { type: "arithmetic" | "compare" }>,
  evaluate: Evaluate,
): FormulaResult => {
  const pair = evaluatePair(node.left, node.right, evaluate);
  if (!Array.isArray(pair)) {
    return pair;
  }
  const [left, right] = pair;
  return node.type === "arithmetic"
    ? arithmetic(node.op, left, right)
    : compare(node.op, left, right);
};

/**
 * Evaluates an expression for one row. Empty inputs propagate as empty (a
 * missing price makes a missing total, not zero); type errors, division by
 * zero and mixed currencies are typed errors.
 */
export const evaluateExpression = (
  node: Expression,
  context: FormulaContext,
): FormulaResult => {
  const evaluate: Evaluate = (child) => evaluateExpression(child, context);
  switch (node.type) {
    case "number":
    case "text":
    case "boolean":
    case "money":
    case "empty":
      return node;
    case "date":
      return dayNumber(node.value) === null ? error("invalid_date") : node;
    case "field":
      return context.field(node.propertyId);
    case "today":
      return { type: "date", value: context.today };
    case "arithmetic":
    case "compare":
      return evaluateBinary(node, evaluate);
    case "unary":
      return evaluateUnary(node, evaluate);
    case "round":
      return evaluateRound(node, evaluate);
    case "days_between":
      return evaluateDaysBetween(node, evaluate);
    case "add_days":
      return evaluateAddDays(node, evaluate);
    case "logic":
      return evaluateLogic(node, evaluate);
    case "not":
      return evaluateNot(node, evaluate);
    case "is_empty": {
      const arg = evaluate(node.arg);
      return isError(arg)
        ? arg
        : { type: "boolean", value: arg.type === "empty" };
    }
    case "condition":
      return {
        type: "boolean",
        value: evaluateCondition(node.node, context.resolveCondition),
      };
    case "if":
      return evaluateIf(node, evaluate);
    case "coalesce":
      return evaluateCoalesce(node, evaluate);
    case "aggregate":
      return aggregate(
        node.fn,
        context.field(node.propertyId),
        context.column(node.propertyId),
      );
    default:
      node satisfies never;
      return panic("Unhandled expression node");
  }
};
