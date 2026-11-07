// A workspace's status is a closed domain owned by
// `@stll/api-contract/workspace-status`. Comparing it with a string literal
// decides, at one site, what a status the domain later adds means there: a
// `!== "active"` check silently refuses it, an `<> 'deleting'` filter silently
// shows it. Name the constant, or ask the owner's predicates
// (`workspaceAcceptsWrites`, `workspaceIsVisible`, `visibleWorkspaceSql`).
//
// Flagged:
//   workspace.status === "archived"
//   matter?.status !== "active"
//   ne(workspaces.status, "deleting")
// Allowed:
//   workspace.status === WORKSPACE_STATUS.archived
//   workspaceAcceptsWrites(matter?.status)
//   eq(workspaces.status, WORKSPACE_STATUS.active)
//
// Syntax only: a status reached through a renamed binding (`const s =
// workspace.status`) is out of scope; the predicates' type guards cover it.

import type { ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

const WORKSPACE_STATUS_LITERALS = new Set(["active", "deleting", "archived"]);
// The holder is a workspace (`workspace`, `targetWorkspace`, `matter`,
// `workspaces`), not an entity named after one (`workspaceMemory`).
const WORKSPACE_HOLDER = /(?:workspace|matter)s?$/iu;
const COMPARISON_OPERATORS = new Set(["===", "!==", "==", "!="]);
const SQL_COMPARISONS = new Set(["eq", "ne", "inArray", "notInArray"]);

const MESSAGE =
  "Compare a workspace status through WORKSPACE_STATUS or the domain's predicates " +
  "(workspaceAcceptsWrites, workspaceIsVisible, visibleWorkspaceSql) from " +
  "@stll/api-contract/workspace-status, not a string literal.";

const holderName = (node: ESTree.Node): string | null => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.type === "ChainExpression") {
    return holderName(node.expression);
  }
  return null;
};

/** `workspace.status`, `matter?.status`, `row.workspace.status`. */
const isWorkspaceStatus = (node: ESTree.Node): boolean => {
  const member = node.type === "ChainExpression" ? node.expression : node;
  if (
    member.type !== "MemberExpression" ||
    member.computed ||
    member.property.type !== "Identifier" ||
    member.property.name !== "status"
  ) {
    return false;
  }
  const holder = holderName(member.object);
  return holder !== null && WORKSPACE_HOLDER.test(holder);
};

const isStatusLiteral = (node: ESTree.Node): boolean =>
  node.type === "Literal" &&
  typeof node.value === "string" &&
  WORKSPACE_STATUS_LITERALS.has(node.value);

const holdsStatusLiteral = (node: ESTree.Node): boolean =>
  isStatusLiteral(node) ||
  (node.type === "ArrayExpression" &&
    node.elements.some(
      (element) => element !== null && isStatusLiteral(element),
    ));

export default eslintCompatPlugin({
  meta: { name: "no-raw-workspace-status" },
  rules: {
    "no-raw-workspace-status": {
      meta: {
        type: "problem",
        messages: { raw: MESSAGE },
      },
      createOnce(context) {
        return {
          BinaryExpression(node) {
            if (!COMPARISON_OPERATORS.has(node.operator)) {
              return;
            }
            const { left, right } = node;
            if (
              (isWorkspaceStatus(left) && isStatusLiteral(right)) ||
              (isStatusLiteral(left) && isWorkspaceStatus(right))
            ) {
              context.report({ node, messageId: "raw" });
            }
          },
          CallExpression(node) {
            const [column, value] = node.arguments;
            // `ne(...)` or a namespaced `d.ne(...)`.
            const callee =
              node.callee.type === "MemberExpression" &&
              node.callee.property.type === "Identifier"
                ? node.callee.property
                : node.callee;
            if (
              callee.type === "Identifier" &&
              SQL_COMPARISONS.has(callee.name) &&
              column !== undefined &&
              value !== undefined &&
              isWorkspaceStatus(column) &&
              holdsStatusLiteral(value)
            ) {
              context.report({ node, messageId: "raw" });
            }
          },
        };
      },
    },
  },
});
