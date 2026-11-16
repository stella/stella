import type { ESTree } from "@oxlint/plugins";

import {
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

// The browser's API client, shared by request guards and the undeclared-write
// ratchet so they recognise the same owner. Modules are
// canonical ids (`canonicalModuleId`), so aliases and relative imports match.
export const API_CLIENT_CLIENT_MODULES = ["apps/web/src/lib/api"];

// `api` is the versioned tree (`apiClient.v1`); `apiClient` reaches the rest.
export const API_CLIENT_CLIENT_EXPORTS = new Set(["api", "apiClient"]);

export const API_CLIENT_WRITE_METHODS = new Set([
  "post",
  "put",
  "patch",
  "delete",
]);

// Writes take `(body, options)`; request options travel second, even
// for a body-less `delete(undefined, request)`.
export const API_CLIENT_WRITE_OPTIONS_INDEX = 1;

export const API_CLIENT_REQUEST_METHODS = new Set([
  "get",
  "head",
  "options",
  ...API_CLIENT_WRITE_METHODS,
]);

/** Trace static route calls and stable aliases; request results and factories are opaque. */
export const resolveApiClientReceiverRoot = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): ESTree.IdentifierReference | null => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (node.type === "MemberExpression") {
    return resolveApiClientReceiverRoot(context, node.object, seen);
  }
  if (node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    const method = memberPropertyName(callee);
    if (
      callee?.type !== "MemberExpression" ||
      method === null ||
      API_CLIENT_REQUEST_METHODS.has(method)
    ) {
      return null;
    }
    return resolveApiClientReceiverRoot(context, callee, seen);
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  const initializer = variable === null ? null : stableInitializer(variable);
  const definition = variable?.defs.at(0);
  if (initializer === null) {
    return node;
  }
  // Destructuring extracts a value from the initializer, not the receiver itself.
  if (
    definition?.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator" ||
    !isIdentifier(definition.node.id)
  ) {
    return null;
  }
  return resolveApiClientReceiverRoot(context, initializer, seen);
};
