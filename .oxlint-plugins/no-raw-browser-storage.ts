import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifierReference,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
  type ScopeContext,
} from "./utils.ts";

const STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const BROWSER_NAMES = new Set(["window", "globalThis", "self"]);

// Shrink-only: consumers use the owners' scoped or device storage APIs.
export const STORAGE_OWNERS = [
  // Account-scoped keys, owner transitions, and pruning.
  "apps/web/src/lib/account/user-scoped-storage.ts",
  // Cross-tab account transition signals.
  "apps/web/src/lib/account/session-signal.ts",
  // Device and tab storage access and blocked-storage handling.
  "apps/web/src/lib/account/browser-storage.ts",
];

const isBrowserObject = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node.type === "ConditionalExpression") {
    return (
      isBrowserObject(context, node.consequent, seen) ||
      isBrowserObject(context, node.alternate, seen)
    );
  }
  if (node.type === "LogicalExpression") {
    return (
      isBrowserObject(context, node.left, seen) ||
      isBrowserObject(context, node.right, seen)
    );
  }
  if (isIdentifierReference(node)) {
    if (BROWSER_NAMES.has(node.name)) {
      return true;
    }
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      isBrowserObject(context, stableInitializer(variable), seen)
    );
  }
  return (
    node.type === "MemberExpression" &&
    BROWSER_NAMES.has(memberPropertyName(node) ?? "") &&
    isBrowserObject(context, node.object, seen)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-browser-storage" },
  rules: {
    "no-raw-browser-storage": {
      meta: {
        type: "problem",
        messages: {
          storageOwner:
            "Browser storage belongs to its account storage owners. Use userStorageKey/userScopedStateStorage for account entries or the browser-storage device/tab helpers.",
        },
      },
      createOnce(context) {
        return {
          Identifier(node) {
            if (
              isFileIn(context, STORAGE_OWNERS) ||
              !isIdentifierReference(node) ||
              !STORAGE_NAMES.has(node.name)
            ) {
              return;
            }
            // Scope references exclude bindings, type members, and object keys.
            const scope = context.sourceCode.getScope(node);
            if (
              scope.references.some(
                (reference) => reference.identifier === node && !reference.init,
              )
            ) {
              context.report({ node, messageId: "storageOwner" });
            }
          },
          MemberExpression(node) {
            if (
              isFileIn(context, STORAGE_OWNERS) ||
              !STORAGE_NAMES.has(memberPropertyName(node) ?? "") ||
              !isBrowserObject(context, node.object)
            ) {
              return;
            }
            context.report({ node, messageId: "storageOwner" });
          },
          VariableDeclarator(node) {
            if (
              isFileIn(context, STORAGE_OWNERS) ||
              node.id.type !== "ObjectPattern" ||
              !isBrowserObject(context, node.init)
            ) {
              return;
            }
            for (const property of node.id.properties) {
              if (!isAstNode(property) || property.type !== "Property") {
                continue;
              }
              const name = property.computed
                ? staticStringValue(property.key)
                : getPropertyName(property.key);
              if (name !== null && STORAGE_NAMES.has(name)) {
                context.report({ node: property, messageId: "storageOwner" });
              }
            }
          },
          AssignmentExpression(node) {
            if (
              isFileIn(context, STORAGE_OWNERS) ||
              !isAstNode(node.left) ||
              node.left.type !== "ObjectPattern" ||
              !Array.isArray(node.left.properties) ||
              !isBrowserObject(context, node.right)
            ) {
              return;
            }
            for (const property of node.left.properties) {
              if (!isAstNode(property) || property.type !== "Property") {
                continue;
              }
              const name = property.computed
                ? staticStringValue(property.key)
                : getPropertyName(property.key);
              if (name !== null && STORAGE_NAMES.has(name)) {
                context.report({ node: property, messageId: "storageOwner" });
              }
            }
          },
        };
      },
    },
  },
});
