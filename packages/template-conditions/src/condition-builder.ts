import { panic } from "better-result";

/**
 * Serializer for the no-code condition builder.
 *
 * A visual builder (all/any groups, nested subgroups, "answer to question X is
 * equal to Y") edits a canonical `@stll/conditions` `ConditionNode` tree;
 * `serializeCondition` renders it into the `{{#if ...}}` expression string that
 * `evaluateCondition` (via `parseCondition`) understands. This is the bridge
 * between the point-and-click UI and the engine — the UI never hand-writes
 * expression syntax, and there is only one condition AST.
 */
import type {
  CompareNode,
  CompareOp,
  ConditionNode,
  GroupNode,
  LiteralValue,
  Operand,
  PredicateNode,
} from "@stll/conditions";

const COMPARE_OP_TO_SYMBOL: Record<CompareOp, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
};

/** Render a literal: strings are quoted/escaped, booleans and numbers are
 *  emitted bare (matching the parser's literal handling); an array literal
 *  joins on `,` (rare; the template builder edits scalar rules). */
const serializeLiteral = (value: LiteralValue): string => {
  if (typeof value === "string") {
    return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
  }
  if (Array.isArray(value)) {
    return `"${value.join(",")}"`;
  }
  return String(value);
};

const serializeOperand = (operand: Operand): string => {
  if (operand.type === "literal") {
    return serializeLiteral(operand.value);
  }
  if (operand.type === "path") {
    return operand.path;
  }
  // A `formula` operand has no `{{#if}}` surface syntax: a condition that uses
  // one must persist as the AST (`conditionHasFormula` gates this at save), so
  // reaching here is a caller routing the wrong condition through the string
  // serializer. Fail fast rather than emit a silently-empty expression.
  if (operand.type === "formula") {
    panic("serializeCondition: formula operand requires AST storage");
  }
  // `property` / `builtin` / `kind` operands belong to the Table domain and
  // never appear in a template condition.
  return "";
};

const serializeCompare = (node: CompareNode): string =>
  `${serializeOperand(node.left)} ${COMPARE_OP_TO_SYMBOL[node.op]} ${serializeOperand(node.right)}`;

const serializePredicate = (node: PredicateNode): string => {
  const operand = serializeOperand(node.operand);
  if (node.op === "contains") {
    const value = Array.isArray(node.value)
      ? node.value.join(",")
      : (node.value ?? "");
    return `${operand} contains ${serializeLiteral(value)}`;
  }
  // `is_truthy` is a bare value; the remaining @stll/conditions predicates
  // (is_empty, starts_with, in, …) have no `{{#if}}` surface syntax, so the
  // template builder only emits truthiness here.
  return operand;
};

const serializeGroup = (group: GroupNode, top: boolean): string => {
  const parts: string[] = [];
  for (const child of group.children) {
    const part = serializeNode(child, false);
    if (part.length > 0) {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    return "";
  }

  const body =
    parts.length === 1
      ? (parts[0] ?? "")
      : parts.join(group.combinator === "and" ? " and " : " or ");

  if (group.negated) {
    return `!(${body})`;
  }
  if (parts.length === 1) {
    // A single child needs neither a joiner nor wrapping parentheses.
    return body;
  }
  // Nested groups are parenthesised to preserve and/or precedence; the
  // top-level group is not, to keep the expression clean.
  return top ? body : `(${body})`;
};

const serializeNode = (node: ConditionNode, top: boolean): string => {
  if (node.type === "compare") {
    return serializeCompare(node);
  }
  if (node.type === "predicate") {
    return serializePredicate(node);
  }
  return serializeGroup(node, top);
};

/**
 * Serialize a condition tree into an expression for `evaluateCondition`.
 * Returns an empty string for an empty tree (caller treats that as "no
 * condition" / always-visible).
 */
export const serializeCondition = (node: ConditionNode): string =>
  serializeNode(node, true);
