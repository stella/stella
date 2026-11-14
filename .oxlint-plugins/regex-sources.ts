import { type AstNode, isAstNode } from "./utils.ts";

/**
 * Visitors that hand every regular-expression source in a file to `check`:
 * a regex literal's pattern, and a string literal passed to `RegExp(…)` or
 * `new RegExp(…)`. Rules that ban a pattern shape share this reach.
 */
export const regexSourceVisitors = (
  check: (node: AstNode, pattern: string) => void,
) => {
  const fromConstruction = (node: unknown) => {
    if (
      !isAstNode(node) ||
      !isAstNode(node.callee) ||
      node.callee.type !== "Identifier" ||
      node.callee.name !== "RegExp"
    ) {
      return;
    }
    const [source] = Array.isArray(node.arguments) ? node.arguments : [];
    if (
      isAstNode(source) &&
      source.type === "Literal" &&
      typeof source.value === "string"
    ) {
      check(node, source.value);
    }
  };
  return {
    Literal(node: unknown) {
      if (
        isAstNode(node) &&
        typeof node.regex === "object" &&
        node.regex !== null &&
        "pattern" in node.regex &&
        typeof node.regex.pattern === "string"
      ) {
        check(node, node.regex.pattern);
      }
    },
    NewExpression: fromConstruction,
    CallExpression: fromConstruction,
  };
};
