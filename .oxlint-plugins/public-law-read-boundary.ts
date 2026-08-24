// Keep the public-law read paths complete and configured before they reach
// shared corpus data.
//
// The language rule is deliberately bound to the two search implementations.
// Both must invoke the shared alternate-count reader in their own function
// body; an import, an identifier reference, or a call tucked in a nested
// callback does not prove the search path invokes it.
//
// The transaction rule is deliberately bound to publicLawReadDb. Its callback
// has two deployment modes: an external public reader and the primary
// database. The rule recognizes the explicit URL branch and requires each
// branch to configure the transaction before the shared callback receives tx.
// It does not prove helper internals, runtime environment values, or dynamic
// control flow outside the accepted shape.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

const SEARCH_FUNCTIONS = new Set([
  "searchPostgresDecisions",
  "searchCorpusIndexDecisions",
]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isFunctionLike = (node: unknown): node is AstNode =>
  isAstNode(node) && FUNCTION_TYPES.has(node.type);

const walkOwnFunctionBody = (
  functionNode: AstNode,
  visit: (node: AstNode) => void,
): void => {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (!isAstNode(value)) {
      return;
    }
    if (value !== functionNode && isFunctionLike(value)) {
      return;
    }

    visit(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        walk(child);
      }
    }
  };

  walk(functionNode.body);
};

const callsIdentifier = (node: AstNode, name: string): boolean =>
  node.type === "CallExpression" &&
  isIdentifier(unwrapExpression(node.callee), name);

const firstArgument = (node: AstNode): unknown =>
  Array.isArray(node.arguments) ? node.arguments.at(0) : undefined;

const invokesInOwnBody = (functionNode: AstNode, name: string): boolean => {
  let found = false;
  walkOwnFunctionBody(functionNode, (node) => {
    if (callsIdentifier(node, name)) {
      found = true;
    }
  });
  return found;
};

const namedFunctionFromDeclarator = (
  node: AstNode,
): readonly [string, AstNode] | null => {
  if (node.type !== "VariableDeclarator" || !isIdentifier(node.id)) {
    return null;
  }
  const initializer = unwrapExpression(node.init);
  return isFunctionLike(initializer) ? [node.id.name, initializer] : null;
};

const isMemberCall = (node: AstNode, property: string): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    callee?.type === "MemberExpression" &&
    callee.computed === false &&
    getPropertyName(callee.property) === property
  );
};

const statementsIn = (node: unknown): readonly AstNode[] =>
  isAstNode(node) && node.type === "BlockStatement" && Array.isArray(node.body)
    ? node.body.filter(isAstNode)
    : [];

const isPublicLawDatabaseUrlCheck = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "BinaryExpression") {
    return false;
  }
  const left = unwrapExpression(node.left);
  return (
    node.operator === "!==" &&
    left?.type === "MemberExpression" &&
    left.computed === false &&
    isIdentifier(left.object, "envBase") &&
    isIdentifier(left.property, "PUBLIC_LAW_DATABASE_URL") &&
    isIdentifier(unwrapExpression(node.right), "undefined")
  );
};

const callsConfiguration = (node: unknown, name: string): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (callsIdentifier(node, name)) {
    return isIdentifier(unwrapExpression(firstArgument(node)), "tx");
  }
  return false;
};

const invokesSharedCallback = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (callsIdentifier(node, "fn")) {
    return isIdentifier(unwrapExpression(firstArgument(node)), "tx");
  }
  return false;
};

const hasCallInOwnBranch = (
  branch: unknown,
  matcher: (node: AstNode) => boolean,
): boolean => {
  if (!isAstNode(branch)) {
    return false;
  }
  let found = false;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (!isAstNode(value) || isFunctionLike(value)) {
      return;
    }
    if (matcher(value)) {
      found = true;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        walk(child);
      }
    }
  };

  walk(branch);
  return found;
};

const transactionCallbackIsConfigured = (functionNode: AstNode): boolean => {
  let callback: AstNode | null = null;
  walkOwnFunctionBody(functionNode, (node) => {
    if (!isMemberCall(node, "transaction") || callback !== null) {
      return;
    }
    const candidate = unwrapExpression(firstArgument(node));
    if (isFunctionLike(candidate)) {
      callback = candidate;
    }
  });
  if (callback === null) {
    return false;
  }

  const statements = statementsIn(callback.body);
  const configurationIndex = statements.findIndex(
    (statement) =>
      statement.type === "IfStatement" &&
      isPublicLawDatabaseUrlCheck(statement.test) &&
      hasCallInOwnBranch(statement.consequent, (node) =>
        callsConfiguration(node, "configureExternalReadTransaction"),
      ) &&
      hasCallInOwnBranch(statement.alternate, (node) =>
        callsConfiguration(node, "configureReadTransaction"),
      ),
  );
  if (configurationIndex === -1) {
    return false;
  }

  return statements
    .slice(configurationIndex + 1)
    .some((statement) => hasCallInOwnBranch(statement, invokesSharedCallback));
};

export default eslintCompatPlugin({
  meta: { name: "public-law-read-boundary" },
  rules: {
    "require-language-alternate-counts": {
      meta: {
        type: "problem",
        messages: {
          missingLanguageAlternateCounts:
            "{{functionName}} must directly invoke readDecisionLanguageAlternateCounts() so every public search result exposes the same route-safe language metadata.",
        },
      },
      createOnce(context) {
        const functions = new Map<string, AstNode>();
        return {
          FunctionDeclaration(node) {
            if (isIdentifier(node.id) && SEARCH_FUNCTIONS.has(node.id.name)) {
              functions.set(node.id.name, node);
            }
          },
          VariableDeclarator(node) {
            const functionEntry = namedFunctionFromDeclarator(node);
            if (
              functionEntry !== null &&
              SEARCH_FUNCTIONS.has(functionEntry[0])
            ) {
              functions.set(...functionEntry);
            }
          },
          "Program:exit"(node) {
            for (const functionName of SEARCH_FUNCTIONS) {
              const functionNode = functions.get(functionName);
              if (
                functionNode === undefined ||
                !invokesInOwnBody(
                  functionNode,
                  "readDecisionLanguageAlternateCounts",
                )
              ) {
                context.report({
                  node: functionNode ?? node,
                  messageId: "missingLanguageAlternateCounts",
                  data: { functionName },
                });
              }
            }
          },
        };
      },
    },
    "require-configured-read-transaction": {
      meta: {
        type: "problem",
        messages: {
          unconfiguredReadTransaction:
            "publicLawReadDb must configure both public-reader transaction branches before invoking fn(tx).",
        },
      },
      createOnce(context) {
        let publicLawReadFunction: AstNode | null = null;
        return {
          VariableDeclarator(node) {
            const functionEntry = namedFunctionFromDeclarator(node);
            if (functionEntry?.[0] === "publicLawReadDb") {
              publicLawReadFunction = functionEntry[1];
            }
          },
          "Program:exit"(node) {
            if (
              publicLawReadFunction === null ||
              !transactionCallbackIsConfigured(publicLawReadFunction)
            ) {
              context.report({
                node: publicLawReadFunction ?? node,
                messageId: "unconfiguredReadTransaction",
              });
            }
          },
        };
      },
    },
  },
});
