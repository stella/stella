import type { ESTree } from "@oxlint/plugins";

import {
  getPropertyName,
  type ImportedFromOptions,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveChainRootName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const FETCH_MODULES = new Set([
  "@stll/fetch",
  "@/api/lib/safe-outbound-fetch",
  "@/api/lib/redirect-fetch",
]);

const CLIENT_MODULES = new Set([
  "@stll/api-client",
  "@/lib/eden-client",
  "@/lib/api",
]);

const CLIENT_MODULE_PREFIX = "@aws-sdk/";
const GLOBAL_FETCH_OBJECTS = new Set(["globalThis", "window", "self"]);

const getType = (node: unknown): string | null =>
  isAstNode(node) ? node.type : null;

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return Reflect.get(node, field);
};

const chainRootReference = (
  value: unknown,
): ESTree.IdentifierReference | null => {
  const expression = unwrapExpression(value);
  if (isIdentifierReference(expression)) {
    return expression;
  }
  if (expression?.type === "CallExpression") {
    return chainRootReference(expression.callee);
  }
  return expression?.type === "MemberExpression"
    ? chainRootReference(expression.object)
    : null;
};

const isAwsCommandSend = (node: unknown): boolean => {
  const callee = getField(node, "callee");
  if (
    getType(callee) !== "MemberExpression" ||
    getField(callee, "computed") === true ||
    getPropertyName(getField(callee, "property")) !== "send"
  ) {
    return false;
  }
  const args = getField(node, "arguments");
  if (!Array.isArray(args) || args.length === 0) {
    return false;
  }
  const first = unwrapExpression(args[0]);
  return (
    getType(first) === "NewExpression" &&
    (resolveChainRootName(getField(first, "callee"))?.endsWith("Command") ??
      false)
  );
};

/** Build the shared binding-aware network and object-storage call detector. */
export const createNetworkCallDetector = (context: RuleContext) => {
  const isUnboundGlobal = (node: unknown): boolean => {
    if (!isIdentifierReference(node)) {
      return false;
    }
    const variable = resolveVariable(context, node);
    return variable === null || variable.defs.length === 0;
  };

  const isGlobalFetchCallee = (value: unknown): boolean => {
    const callee = unwrapExpression(value);
    if (isIdentifier(callee, "fetch")) {
      return isUnboundGlobal(callee);
    }
    if (
      callee?.type !== "MemberExpression" ||
      memberPropertyName(callee) !== "fetch"
    ) {
      return false;
    }
    const receiver = unwrapExpression(callee.object);
    return (
      isIdentifier(receiver) &&
      GLOBAL_FETCH_OBJECTS.has(receiver.name) &&
      isUnboundGlobal(receiver)
    );
  };

  return (node: unknown): boolean => {
    if (getType(node) !== "CallExpression") {
      return false;
    }
    if (
      isGlobalFetchCallee(getField(node, "callee")) ||
      isAwsCommandSend(node)
    ) {
      return true;
    }
    const root = chainRootReference(node);
    const imported =
      root === null
        ? null
        : resolveImportedExpressionForEnforcement(context, root);
    return (
      imported !== null &&
      (FETCH_MODULES.has(imported.source) ||
        CLIENT_MODULES.has(imported.source) ||
        imported.source.startsWith(CLIENT_MODULE_PREFIX))
    );
  };
};
