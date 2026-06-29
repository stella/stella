import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { evaluateCondition, MAX_CONDITION_DEPTH } from "./index";

const BOOLEAN_PATHS = ["isUK", "hasLicense", "nested.approved"] as const;
const NUMBER_PATHS = ["amount", "threshold"] as const;
const STRING_PATHS = ["country", "status"] as const;
const STRING_VALUES = ["UK", "DE", "active", "draft", ""] as const;
const NUMERIC_OPERATORS = [">", "<", ">=", "<=", "==", "!="] as const;
const EQUALITY_OPERATORS = ["==", "!="] as const;

const unexpectedTestValue = (value: never): never => {
  throw new Error(`Unexpected generated test value: ${String(value)}`);
};

type BooleanPath = (typeof BOOLEAN_PATHS)[number];
type NumberPath = (typeof NUMBER_PATHS)[number];
type StringPath = (typeof STRING_PATHS)[number];
type StringLiteral = (typeof STRING_VALUES)[number];
type NumericOperator = (typeof NUMERIC_OPERATORS)[number];
type EqualityOperator = (typeof EQUALITY_OPERATORS)[number];
type StringOperand =
  | { type: "path"; value: StringPath }
  | { type: "literal"; value: StringLiteral };

type ConditionData = {
  isUK: boolean;
  hasLicense: boolean;
  nested: {
    approved: boolean;
  };
  amount: number;
  threshold: number;
  country: string;
  status: string;
};

type ExprNode =
  | { type: "truthy"; path: BooleanPath | NumberPath | StringPath }
  | { type: "not"; child: ExprNode }
  | { type: "and"; left: ExprNode; right: ExprNode }
  | { type: "or"; left: ExprNode; right: ExprNode }
  | {
      type: "numberComparison";
      left: NumberPath;
      op: NumericOperator;
      right: NumberPath | number;
    }
  | {
      type: "stringComparison";
      left: StringPath;
      op: EqualityOperator;
      right: StringOperand;
    }
  | {
      type: "booleanComparison";
      left: BooleanPath;
      op: EqualityOperator;
      right: BooleanPath | boolean;
    };

const conditionData = fc.record<ConditionData>({
  isUK: fc.boolean(),
  hasLicense: fc.boolean(),
  nested: fc.record({
    approved: fc.boolean(),
  }),
  amount: fc.integer({ min: 0, max: 10_000 }),
  threshold: fc.integer({ min: 0, max: 10_000 }),
  country: fc.constantFrom(...STRING_VALUES),
  status: fc.constantFrom(...STRING_VALUES),
});

const path = fc.constantFrom(
  ...BOOLEAN_PATHS,
  ...NUMBER_PATHS,
  ...STRING_PATHS,
);

const numberPath = fc.constantFrom(...NUMBER_PATHS);
const stringPath = fc.constantFrom(...STRING_PATHS);
const booleanPath = fc.constantFrom(...BOOLEAN_PATHS);

const includesString = <T extends string>(
  values: readonly T[],
  value: string,
): value is T => values.some((candidate) => candidate === value);

const isBooleanPath = (operand: string): operand is BooleanPath =>
  includesString(BOOLEAN_PATHS, operand);

const isNumberPath = (operand: string): operand is NumberPath =>
  includesString(NUMBER_PATHS, operand);

type NumberComparisonNode = Extract<ExprNode, { type: "numberComparison" }>;
type StringComparisonNode = Extract<ExprNode, { type: "stringComparison" }>;
type BooleanComparisonNode = Extract<ExprNode, { type: "booleanComparison" }>;

const numberExpression: fc.Arbitrary<NumberComparisonNode> = fc.record({
  type: fc.constant("numberComparison"),
  left: numberPath,
  op: fc.constantFrom(...NUMERIC_OPERATORS),
  right: fc.oneof(numberPath, fc.integer({ min: 0, max: 10_000 })),
});

const stringExpression: fc.Arbitrary<StringComparisonNode> = fc.record({
  type: fc.constant("stringComparison"),
  left: stringPath,
  op: fc.constantFrom(...EQUALITY_OPERATORS),
  right: fc.oneof(
    stringPath.map((value): StringOperand => ({ type: "path", value })),
    fc
      .constantFrom(...STRING_VALUES)
      .map((value): StringOperand => ({ type: "literal", value })),
  ),
});

const booleanExpression: fc.Arbitrary<BooleanComparisonNode> = fc.record({
  type: fc.constant("booleanComparison"),
  left: booleanPath,
  op: fc.constantFrom(...EQUALITY_OPERATORS),
  right: fc.oneof(booleanPath, fc.boolean()),
});

const exprNode: fc.Arbitrary<ExprNode> = fc.letrec<{
  expr: ExprNode;
}>((tie) => ({
  expr: fc.oneof(
    { depthSize: "small", maxDepth: MAX_CONDITION_DEPTH },
    path.map((p): ExprNode => ({ type: "truthy", path: p })),
    numberExpression,
    stringExpression,
    booleanExpression,
    tie("expr").map((child): ExprNode => ({ type: "not", child })),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]): ExprNode => ({ type: "and", left, right })),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]): ExprNode => ({ type: "or", left, right })),
  ),
})).expr;

const resolveBooleanPath = (
  data: ConditionData,
  expressionPath: BooleanPath,
): boolean => {
  switch (expressionPath) {
    case "isUK":
      return data.isUK;
    case "hasLicense":
      return data.hasLicense;
    case "nested.approved":
      return data.nested.approved;
    default:
      return unexpectedTestValue(expressionPath);
  }
};

const resolveNumberPath = (
  data: ConditionData,
  expressionPath: NumberPath,
): number => {
  switch (expressionPath) {
    case "amount":
      return data.amount;
    case "threshold":
      return data.threshold;
    default:
      return unexpectedTestValue(expressionPath);
  }
};

const resolveStringPath = (
  data: ConditionData,
  expressionPath: StringPath,
): string => {
  switch (expressionPath) {
    case "country":
      return data.country;
    case "status":
      return data.status;
    default:
      return unexpectedTestValue(expressionPath);
  }
};

const isReferenceTruthy = (value: boolean | number | string): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return value.length > 0;
};

const resolveNumberOperand = (
  data: ConditionData,
  operand: NumberPath | number,
): number => {
  if (typeof operand === "number") {
    return operand;
  }
  return resolveNumberPath(data, operand);
};

const resolveStringOperand = (
  data: ConditionData,
  operand: StringOperand,
): string => {
  if (operand.type === "path") {
    return resolveStringPath(data, operand.value);
  }
  return operand.value;
};

const resolveBooleanOperand = (
  data: ConditionData,
  operand: BooleanPath | boolean,
): boolean => {
  if (typeof operand === "boolean") {
    return operand;
  }
  return resolveBooleanPath(data, operand);
};

const compareReferenceNumbers = (
  left: number,
  op: NumericOperator,
  right: number,
): boolean => {
  switch (op) {
    case ">":
      return left > right;
    case "<":
      return left < right;
    case ">=":
      return left >= right;
    case "<=":
      return left <= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return unexpectedTestValue(op);
  }
};

const compareReferenceEquality = <T>(
  left: T,
  op: EqualityOperator,
  right: T,
): boolean => {
  if (op === "==") {
    return left === right;
  }
  return left !== right;
};

const evaluateReference = (node: ExprNode, data: ConditionData): boolean => {
  switch (node.type) {
    case "truthy":
      if (isBooleanPath(node.path)) {
        return isReferenceTruthy(resolveBooleanPath(data, node.path));
      }
      if (isNumberPath(node.path)) {
        return isReferenceTruthy(resolveNumberPath(data, node.path));
      }
      return isReferenceTruthy(resolveStringPath(data, node.path));
    case "not":
      return !evaluateReference(node.child, data);
    case "and":
      return (
        evaluateReference(node.left, data) &&
        evaluateReference(node.right, data)
      );
    case "or":
      return (
        evaluateReference(node.left, data) ||
        evaluateReference(node.right, data)
      );
    case "numberComparison":
      return compareReferenceNumbers(
        resolveNumberOperand(data, node.left),
        node.op,
        resolveNumberOperand(data, node.right),
      );
    case "stringComparison":
      return compareReferenceEquality(
        resolveStringPath(data, node.left),
        node.op,
        resolveStringOperand(data, node.right),
      );
    case "booleanComparison":
      return compareReferenceEquality(
        resolveBooleanOperand(data, node.left),
        node.op,
        resolveBooleanOperand(data, node.right),
      );
    default:
      return unexpectedTestValue(node);
  }
};

type RenderableOperand = BooleanPath | NumberPath | boolean | number;

const renderOperand = (operand: RenderableOperand): string => {
  if (typeof operand === "boolean") {
    return String(operand);
  }
  if (typeof operand === "number") {
    return String(operand);
  }
  if (isBooleanPath(operand)) {
    return operand;
  }
  if (isNumberPath(operand)) {
    return operand;
  }
  return operand;
};

const renderStringOperand = (operand: StringOperand): string => {
  if (operand.type === "path") {
    return operand.value;
  }
  return JSON.stringify(operand.value);
};

const PRECEDENCE = {
  or: 1,
  and: 2,
  unary: 3,
  atom: 4,
} as const;

const wrapIfNeeded = (
  expression: string,
  precedence: number,
  parentPrecedence: number,
): string => {
  if (precedence < parentPrecedence) {
    return `(${expression})`;
  }
  return expression;
};

const renderExpression = (node: ExprNode, parentPrecedence = 0): string => {
  switch (node.type) {
    case "truthy":
      return node.path;
    case "not":
      return wrapIfNeeded(
        `!(${renderExpression(node.child)})`,
        PRECEDENCE.unary,
        parentPrecedence,
      );
    case "and":
      return wrapIfNeeded(
        `${renderExpression(node.left, PRECEDENCE.and)} and ${renderExpression(node.right, PRECEDENCE.and)}`,
        PRECEDENCE.and,
        parentPrecedence,
      );
    case "or":
      return wrapIfNeeded(
        `${renderExpression(node.left, PRECEDENCE.or)} or ${renderExpression(node.right, PRECEDENCE.or)}`,
        PRECEDENCE.or,
        parentPrecedence,
      );
    case "numberComparison":
      return `${node.left} ${node.op} ${renderOperand(node.right)}`;
    case "stringComparison":
      return `${node.left} ${node.op} ${renderStringOperand(node.right)}`;
    case "booleanComparison":
      return `${node.left} ${node.op} ${renderOperand(node.right)}`;
    default:
      return unexpectedTestValue(node);
  }
};

describe("evaluateCondition property checks", () => {
  test("matches an independent evaluator for generated boolean expressions", () => {
    fc.assert(
      fc.property(exprNode, conditionData, (node, data) => {
        expect(evaluateCondition(renderExpression(node), data)).toBe(
          evaluateReference(node, data),
        );
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });
});
