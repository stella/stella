// Ban network and object-storage awaits inside inline database transaction
// callbacks. Holding a transaction open across remote I/O increases lock time
// and makes database completion depend on an unrelated system.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { createNetworkCallDetector } from "./network-call.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isResultTryPromiseCallback,
  unwrapExpression,
} from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const getType = (node: unknown): string | null =>
  isAstNode(node) ? node.type : null;

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return Reflect.get(node, field);
};

const isTransactionCallback = (node: unknown): boolean => {
  const call = getField(node, "parent");
  if (getType(call) !== "CallExpression") {
    return false;
  }
  const args = getField(call, "arguments");
  if (!Array.isArray(args) || args.at(0) !== node) {
    return false;
  }
  const callee = unwrapExpression(getField(call, "callee"));
  return (
    callee?.type === "MemberExpression" &&
    getPropertyName(callee.property) === "transaction"
  );
};

const isInsideTransactionCallback = (node: unknown): boolean => {
  let current = getField(node, "parent");
  while (current !== null && current !== undefined) {
    const type = getType(current);
    if (type !== null && FUNCTION_TYPES.has(type)) {
      if (isTransactionCallback(current)) {
        return true;
      }
      if (!isResultTryPromiseCallback(current)) {
        return false;
      }
    }
    current = getField(current, "parent");
  }
  return false;
};

const getResultAwaitArgument = (node: unknown): unknown => {
  if (getType(node) !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(getField(node, "callee"));
  if (
    callee?.type !== "MemberExpression" ||
    getField(callee, "computed") === true ||
    !isIdentifier(callee.object, "Result") ||
    getPropertyName(callee.property) !== "await"
  ) {
    return null;
  }
  const args = getField(node, "arguments");
  return Array.isArray(args) && args.length === 1
    ? unwrapExpression(args[0])
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-network-in-transaction" },
  rules: {
    "no-network-in-transaction": {
      meta: {
        type: "problem",
        messages: {
          noNetworkInTransaction:
            "Do network and object-storage I/O before or after the database transaction, not inside its callback.",
        },
      },
      createOnce(context) {
        const isNetworkCall = createNetworkCallDetector(context);
        const reportAwaitedExpression = (
          node: ESTree.AwaitExpression | ESTree.YieldExpression,
          argument: unknown,
        ): void => {
          if (isNetworkCall(argument) && isInsideTransactionCallback(node)) {
            context.report({ node, messageId: "noNetworkInTransaction" });
          }
        };

        return {
          AwaitExpression(node) {
            reportAwaitedExpression(node, unwrapExpression(node.argument));
          },
          YieldExpression(node) {
            if (getField(node, "delegate") !== true) {
              return;
            }
            const argument = getResultAwaitArgument(
              unwrapExpression(getField(node, "argument")),
            );
            if (argument !== null) {
              reportAwaitedExpression(node, argument);
            }
          },
        };
      },
    },
  },
});
