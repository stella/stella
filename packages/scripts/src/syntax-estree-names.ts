import type { Node } from "./syntax-tree";

/**
 * ESTree's own names. oxc types identifiers and properties by role (binding,
 * reference, object literal entry, pattern entry, …); these are every node
 * that carries the ESTree tag.
 */
export type IdentifierNode = Extract<Node, { type: "Identifier" }>;
export type PropertyNode = Extract<Node, { type: "Property" }>;
