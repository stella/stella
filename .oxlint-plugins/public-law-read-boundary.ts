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
  node: unknown,
): readonly [string, AstNode] | null => {
  if (
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isIdentifier(node.id)
  ) {
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

const directAwaitedCall = (statement: unknown): AstNode | undefined => {
  if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
    return undefined;
  }
  const expression = unwrapExpression(statement.expression);
  if (expression?.type !== "AwaitExpression") {
    return undefined;
  }
  const call = unwrapExpression(expression.argument);
  return call?.type === "CallExpression" ? call : undefined;
};

const isUnconditionalConfigurationBranch = (
  branch: unknown,
  name: string,
): boolean => {
  const statements = statementsIn(branch);
  return (
    statements.length === 1 &&
    callsConfiguration(directAwaitedCall(statements.at(0)), name)
  );
};

const directlyReturnsSharedCallback = (statement: unknown): boolean => {
  if (!isAstNode(statement) || statement.type !== "ReturnStatement") {
    return false;
  }
  const returned = unwrapExpression(statement.argument);
  const call =
    returned?.type === "AwaitExpression"
      ? unwrapExpression(returned.argument)
      : returned;
  return invokesSharedCallback(call);
};

const transactionCallbackIsConfigured = (functionNode: AstNode): boolean => {
  const callbacks: AstNode[] = [];
  walkOwnFunctionBody(functionNode, (node) => {
    if (!isMemberCall(node, "transaction") || callbacks.length > 0) {
      return;
    }
    const candidate = unwrapExpression(firstArgument(node));
    if (isFunctionLike(candidate)) {
      callbacks.push(candidate);
    }
  });
  const callback = callbacks.at(0);
  if (callback === undefined) {
    return false;
  }

  const statements = statementsIn(callback.body);
  const configurationIndex = statements.findIndex(
    (statement) =>
      statement.type === "IfStatement" &&
      isPublicLawDatabaseUrlCheck(statement.test) &&
      isUnconditionalConfigurationBranch(
        statement.consequent,
        "configureExternalReadTransaction",
      ) &&
      isUnconditionalConfigurationBranch(
        statement.alternate,
        "configureReadTransaction",
      ),
  );
  if (configurationIndex === -1) {
    return false;
  }

  return statements
    .slice(configurationIndex + 1)
    .some(directlyReturnsSharedCallback);
};

export default eslintCompatPlugin({
  meta: { name: "public-law-read-boundary" },
  rules: {
    "require-language-alternate-counts": {
      meta: {
        type: "problem",
        messages: {
          missingLanguageAlternateCounts:
            "{{functionName}} must directly invoke readPublicDecisionLanguageAlternatesByGroup() so every public search result exposes the same route-safe language versions.",
        },
      },
      createOnce(context) {
        const functions = new Map<string, AstNode>();
        return {
          FunctionDeclaration(node) {
            if (
              isAstNode(node) &&
              isIdentifier(node.id) &&
              SEARCH_FUNCTIONS.has(node.id.name)
            ) {
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
                  "readPublicDecisionLanguageAlternatesByGroup",
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
