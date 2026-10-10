import { eslintCompatPlugin } from "@oxlint/plugins";
// getInitials and getDisplayName have one canonical implementation under the
// web lib directory. A workspace component redeclared both names with
// different token selection and fallback behavior, and another component
// imported that shadow copy, so the same user received different visible
// labels and initials across one page.
//
// The ban is deliberately scoped to module-level declarations with these two
// exact names outside `apps/web/src/lib/`; unrelated naming helpers remain
// valid. No legitimate shadow implementation is spared. The
// `shadowed-user-name-helpers` ratchet metric covers re-exports and syntactic
// variants the declaration-based AST rule cannot identify.

import { filenameForContext, isAstNode } from "./utils.ts";

const BANNED_NAMES = new Set(["getDisplayName", "getInitials"]);

const declaredName = (node: unknown): string | null =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  node.type === "Identifier" &&
  "name" in node &&
  typeof node.name === "string"
    ? node.name
    : null;

const isModuleLevel = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const parent = node.parent;
  if (typeof parent !== "object" || parent === null) {
    return false;
  }
  if ("type" in parent && parent.type === "Program") {
    return true;
  }
  if (!("parent" in parent)) {
    return false;
  }
  const grandparent = parent.parent;
  if (typeof grandparent !== "object" || grandparent === null) {
    return false;
  }
  if ("type" in grandparent && grandparent.type === "Program") {
    return true;
  }
  return (
    "type" in grandparent &&
    grandparent.type === "ExportNamedDeclaration" &&
    "parent" in grandparent &&
    typeof grandparent.parent === "object" &&
    grandparent.parent !== null &&
    "type" in grandparent.parent &&
    grandparent.parent.type === "Program"
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-shadowed-user-name-helpers" },
  rules: {
    "no-shadowed-user-name-helpers": {
      meta: {
        type: "problem",
        messages: {
          shadowedHelper:
            "Do not declare {{name}} outside apps/web/src/lib. Import the " +
            "canonical helper instead.",
        },
      },
      createOnce(context) {
        const shadowedName = (node: unknown): string | null => {
          if (!isModuleLevel(node)) {
            return null;
          }
          if (!isAstNode(node)) {
            return null;
          }
          const name = declaredName(node.id);
          return name !== null && BANNED_NAMES.has(name) ? name : null;
        };
        const report = (node, name: string | null) => {
          if (name !== null) {
            context.report({
              node,
              messageId: "shadowedHelper",
              data: { name },
            });
          }
        };
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/web/src/") ||
                filename.endsWith(
                  ".oxlint-plugins/__fixtures__/no-shadowed-user-name-helpers.fixture.ts",
                )) &&
              !filename.includes("apps/web/src/lib/")
            );
          },
          FunctionDeclaration(node) {
            report(node, shadowedName(node));
          },
          VariableDeclarator(node) {
            report(node, shadowedName(node));
          },
        };
      },
    },
  },
});
