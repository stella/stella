/**
 * Structural predicates over the condition AST — pure traversals with no
 * evaluation. Kept separate from `./evaluate` (semantics) and `./schema`
 * (shapes) so consumers can ask "what is in this tree" without an evaluator.
 */
import type { ConditionNode, Operand } from "./schema";

/** Every operand referenced by a leaf node, in source order. */
const leafOperands = (node: ConditionNode): Operand[] => {
  if (node.type === "compare") {
    return [node.left, node.right];
  }
  if (node.type === "predicate") {
    return [node.operand];
  }
  return [];
};

/**
 * Whether any leaf in the tree uses a `formula` operand. Formula operands only
 * evaluate in the JS template domain, so callers use this to gate persistence
 * (store the AST, not a `{{#if}}` string) and to strip such nodes at the SQL
 * filter boundary.
 */
export const conditionHasFormula = (node: ConditionNode): boolean => {
  if (node.type === "group") {
    return node.children.some(conditionHasFormula);
  }
  return leafOperands(node).some((operand) => operand.type === "formula");
};

/** Whether a condition tree explicitly includes an entity kind. */
export const conditionIncludesKind = (
  nodes: readonly ConditionNode[],
  kind: string,
): boolean =>
  nodes.some((node) => {
    if (node.type === "group") {
      return conditionIncludesKind(node.children, kind);
    }
    if (
      node.type !== "predicate" ||
      node.operand.type !== "kind" ||
      node.op !== "in" ||
      !Array.isArray(node.value)
    ) {
      return false;
    }
    return node.value.includes(kind);
  });
