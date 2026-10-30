/**
 * Invariant: identified raw API client errors are normalized before captureError or
 * captureException so the captured error can retain its message and status.
 *
 * Rejected: response.error, destructured error bindings and immutable aliases
 * from requests through the registered `@/lib/api` client imports, including
 * parameterized client calls and awaited responses.
 * Accepted: toAPIError(error), unwrapApiResponse(response), and unrelated errors.
 *
 * Boundary: static import provenance and local immutable aliases, not general
 * interprocedural taint analysis. Errors passed through parameters, mutable
 * bindings, containers or other helper returns, and unregistered clients are
 * not tracked. Capture calls are identified by method/function name; this
 * detection is not a runtime guarantee that every captured error is normalized.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import type { ImportedFromOptions } from "./utils.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

type Context = ImportedFromOptions["context"];
type Origin = "client" | "response" | "error" | null;
const REQUEST_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const CLIENT_EXPORTS = new Set(["api", "apiClient"]);

const isRequestMethod = (value: unknown): boolean => {
  const callee = unwrapExpression(value);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  return method !== null && REQUEST_METHODS.has(method);
};

const originOf = (
  context: Context,
  value: unknown,
  visited = new Set<unknown>(),
): Origin => {
  const node = unwrapExpression(value);
  if (node === null || visited.has(node)) {
    return null;
  }
  visited.add(node);
  if (
    isImportedFrom({
      context,
      node,
      modules: ["@/lib/api", "apps/web/src/lib/api"],
      names: CLIENT_EXPORTS,
    })
  ) {
    return "client";
  }
  if (node.type === "AwaitExpression") {
    return originOf(context, node.argument, visited);
  }
  if (node.type === "MemberExpression") {
    const origin = originOf(context, node.object, visited);
    if (origin === "client") {
      return "client";
    }
    if (origin === "response" && memberPropertyName(node) === "error") {
      return "error";
    }
    return null;
  }
  if (node.type === "CallExpression") {
    if (originOf(context, node.callee, visited) !== "client") {
      return null;
    }
    return isRequestMethod(node.callee) ? "response" : "client";
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null) {
    return null;
  }
  const initializer = stableInitializer(variable);
  if (initializer === null) {
    return null;
  }
  const definition = variable.defs.at(0);
  if (!isAstNode(definition?.node)) {
    return null;
  }
  const pattern = definition.node.id;
  if (!isAstNode(pattern) || pattern.type !== "ObjectPattern") {
    return originOf(context, initializer, visited);
  }
  if (!Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      !isIdentifierReference(property.value) ||
      property.value.name !== node.name
    ) {
      continue;
    }
    return getPropertyName(property.key) === "error" &&
      originOf(context, initializer, visited) === "response"
      ? "error"
      : null;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-api-error-telemetry" },
  rules: {
    "no-raw-api-error-telemetry": {
      meta: {
        type: "problem",
        messages: {
          rawApiError:
            "Convert API errors with toAPIError() or unwrapApiResponse() before captureError/captureException so telemetry retains the message and status.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node) || !Array.isArray(node.arguments)) {
              return;
            }
            const callee = unwrapExpression(node.callee);
            if (callee === null) {
              return;
            }
            const name =
              callee.type === "MemberExpression"
                ? memberPropertyName(callee)
                : isIdentifierReference(callee)
                  ? callee.name
                  : null;
            if (name !== "captureError" && name !== "captureException") {
              return;
            }
            if (originOf(context, node.arguments.at(0)) === "error") {
              context.report({ node, messageId: "rawApiError" });
            }
          },
        };
      },
    },
  },
});
