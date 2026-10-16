// Resolve the Eden client's imports and immutable aliases; arbitrary errors
// with the same local names must remain valid telemetry inputs.
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
const CLIENT_EXPORTS = new Set([
  "api",
  "linkIconsApi",
  "correspondenceApi",
  "memoriesApi",
  "myTimeEntriesApi",
  "publicFeedbackApi",
]);

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
      modules: [
        "@/lib/api",
        "@/lib/eden-client",
        "apps/web/src/lib/api",
        "apps/web/src/lib/eden-client",
      ],
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
  meta: { name: "no-raw-eden-telemetry" },
  rules: {
    "no-raw-eden-telemetry": {
      meta: {
        type: "problem",
        messages: {
          rawEden:
            "Convert Eden errors with toAPIError() or unwrapEden() before captureError/captureException so telemetry retains the message and status.",
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
              context.report({ node, messageId: "rawEden" });
            }
          },
        };
      },
    },
  },
});
