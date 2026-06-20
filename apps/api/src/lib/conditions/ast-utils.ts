/**
 * Structural helpers for walking and rewriting the condition AST in
 * view layouts: remapping property ids, collecting referenced
 * property ids, and dropping nodes that reference deleted properties.
 * These operate on `ConditionNode` so the legacy `field`-keyed shape
 * is never touched (callers upgrade first via `parseViewLayout`).
 */
import type { ConditionNode, Operand } from "@stll/conditions";

const remapOperand = (
  operand: Operand,
  remap: (id: string) => string,
): Operand => {
  if (operand.type === "property") {
    return { type: "property", propertyId: remap(operand.propertyId) };
  }
  return operand;
};

/** Returns a new node with every `property` operand id remapped. */
export const remapNodePropertyIds = (
  node: ConditionNode,
  remap: (id: string) => string,
): ConditionNode => {
  switch (node.type) {
    case "group":
      return {
        ...node,
        children: node.children.map((child) =>
          remapNodePropertyIds(child, remap),
        ),
      };
    case "compare":
      return {
        ...node,
        left: remapOperand(node.left, remap),
        right: remapOperand(node.right, remap),
      };
    case "predicate":
      return { ...node, operand: remapOperand(node.operand, remap) };
    default:
      return node;
  }
};

const collectOperand = (operand: Operand, into: Set<string>): void => {
  if (operand.type === "property") {
    into.add(operand.propertyId);
  }
};

/** Adds every `property` operand id referenced by the node to `into`. */
export const collectNodePropertyIds = (
  node: ConditionNode,
  into: Set<string>,
): void => {
  switch (node.type) {
    case "group":
      for (const child of node.children) {
        collectNodePropertyIds(child, into);
      }
      return;
    case "compare":
      collectOperand(node.left, into);
      collectOperand(node.right, into);
      return;
    case "predicate":
      collectOperand(node.operand, into);
      return;
    default:
  }
};

/**
 * A node is retained when every `property` operand it references is
 * still valid. Kind/builtin operands carry no property id, so nodes
 * built solely on them are always retained.
 */
export const nodeReferencesOnlyValidProperties = (
  node: ConditionNode,
  isValidPropertyId: (id: string) => boolean,
): boolean => {
  const referenced = new Set<string>();
  collectNodePropertyIds(node, referenced);
  for (const id of referenced) {
    if (!isValidPropertyId(id)) {
      return false;
    }
  }
  return true;
};

/**
 * Drops only the leaf conditions that reference a deleted property, recursing
 * into groups so valid siblings survive. Returns `null` when a leaf is invalid
 * or a group is left empty — so one stale child no longer drops a whole group.
 */
export const pruneStaleNode = (
  node: ConditionNode,
  isValidPropertyId: (id: string) => boolean,
): ConditionNode | null => {
  if (node.type === "group") {
    const children = node.children
      .map((child) => pruneStaleNode(child, isValidPropertyId))
      .filter((child): child is ConditionNode => child !== null);
    if (children.length === 0) {
      return null;
    }
    return { ...node, children };
  }
  return nodeReferencesOnlyValidProperties(node, isValidPropertyId)
    ? node
    : null;
};

/**
 * Remaps both property references a dependency carries — the edge
 * (`dependsOnPropertyId`) and the gate `condition`'s operands — through one
 * `remap`, so a copy (workspace duplicate, template apply) can never remap one
 * without the other. Returns `null` when the edge endpoint does not remap, so
 * the caller drops the dependency rather than creating a dangling edge.
 */
export const remapDependencyRefs = <T extends string>(
  source: { dependsOnPropertyId: string; condition: ConditionNode | null },
  remap: (id: string) => T | undefined,
): { dependsOnPropertyId: T; condition: ConditionNode | null } | null => {
  const dependsOnPropertyId = remap(source.dependsOnPropertyId);
  if (dependsOnPropertyId === undefined) {
    return null;
  }
  return {
    dependsOnPropertyId,
    condition: source.condition
      ? remapNodePropertyIds(source.condition, (id) => remap(id) ?? id)
      : null,
  };
};
