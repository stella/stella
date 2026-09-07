/**
 * What a `{% if %}` expression reads. Structural, not evaluative: the paths a
 * condition depends on, for callers that decide something about the condition
 * itself rather than about a document being filled.
 */

import type { ConditionNode, Operand } from "@stll/conditions";

import { parseCondition } from "./parse.js";

const operandsOf = (
  node: Exclude<ConditionNode, { type: "group" }>,
): Operand[] =>
  node.type === "compare" ? [node.left, node.right] : [node.operand];

/** Every field path the tree reads, or `null` when an operand names something
 *  whose own references cannot be enumerated (a formula over other fields). */
const nodePaths = (node: ConditionNode): string[] | null => {
  if (node.type === "group") {
    const paths: string[] = [];
    for (const child of node.children) {
      const childPaths = nodePaths(child);
      if (childPaths === null) {
        return null;
      }
      paths.push(...childPaths);
    }
    return paths;
  }
  const paths: string[] = [];
  for (const operand of operandsOf(node)) {
    if (operand.type === "formula") {
      return null;
    }
    if (operand.type === "path") {
      paths.push(operand.path);
    }
  }
  return paths;
};

/**
 * Every field path an expression reads, in source order.
 *
 * `null` says the expression does not answer the question: it did not parse,
 * or it reads an operand whose own references cannot be enumerated. A caller
 * deciding what a condition depends on must not read that as "depends on
 * nothing".
 */
export const referencedConditionPaths = (
  expression: string,
): string[] | null => {
  const node = parseCondition(expression);
  return node === null ? null : nodePaths(node);
};
