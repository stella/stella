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

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isImportedFrom,
  isIdentifierReference,
  isSingleAssignment,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, resolveImport, ScopeContext } from "./utils.ts";

const ALTERNATE_READERS = new Set([
  "readPublicDecisionLanguageAlternatesByGroup",
]);

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

const firstArgument = (node: AstNode): unknown =>
  Array.isArray(node.arguments) ? node.arguments.at(0) : undefined;

type ImportResolutionContext = Parameters<typeof resolveImport>[0];

const invokesInOwnBody = (
  functionNode: AstNode,
  context: ImportResolutionContext,
): boolean => {
  let found = false;
  walkOwnFunctionBody(functionNode, (node) => {
    if (
      node.type === "CallExpression" &&
      isImportedFrom({
        context,
        node: node.callee,
        modules: ["apps/api/src/lib/case-law/language-alternates"],
        names: ALTERNATE_READERS,
      })
    ) {
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

const transactionsAreConfigured = (
  context: ScopeContext,
  functionNode: AstNode,
): boolean => {
  const sharedParameter = Array.isArray(functionNode.params)
    ? functionNode.params.at(0)
    : null;
  if (!isIdentifierReference(sharedParameter)) {
    return false;
  }
  const sharedBinding = resolveVariable(context, sharedParameter);
  if (sharedBinding === null || !isSingleAssignment(sharedBinding)) {
    return false;
  }
  // The owner helper is a module binding; a callback-local namesake cannot
  // establish transaction configuration.
  let configurationBinding: Variable | null = null;
  let scope = context.sourceCode.getScope(sharedParameter);
  while (true) {
    if (scope.type === "module" || scope.type === "global") {
      configurationBinding = scope.set.get("configureReadTransaction") ?? null;
      break;
    }
    if (scope.upper === null) {
      break;
    }
    scope = scope.upper;
  }
  if (
    configurationBinding !== null &&
    !isSingleAssignment(configurationBinding)
  ) {
    return false;
  }
  const transactions: AstNode[] = [];
  walkOwnFunctionBody(functionNode, (node) => {
    if (isMemberCall(node, "transaction")) {
      transactions.push(node);
    }
  });
  return (
    transactions.length > 0 &&
    transactions.every((transaction) => {
      const callback = unwrapExpression(firstArgument(transaction));
      if (!isFunctionLike(callback)) {
        return false;
      }
      const transactionParameter = Array.isArray(callback.params)
        ? callback.params.at(0)
        : null;
      if (!isIdentifierReference(transactionParameter)) {
        return false;
      }
      const transactionBinding = resolveVariable(context, transactionParameter);
      if (
        transactionBinding === null ||
        !isSingleAssignment(transactionBinding)
      ) {
        return false;
      }
      const takesTransaction = (call: AstNode) => {
        const argument = unwrapExpression(firstArgument(call));
        return (
          isIdentifierReference(argument) &&
          resolveVariable(context, argument) === transactionBinding
        );
      };
      const invokesSharedCallback = (node: unknown): node is AstNode => {
        if (!isAstNode(node) || node.type !== "CallExpression") {
          return false;
        }
        const callee = unwrapExpression(node.callee);
        return (
          isIdentifierReference(callee) &&
          resolveVariable(context, callee) === sharedBinding
        );
      };
      const statements = statementsIn(callback.body);
      // Conditional configuration cannot establish a configured read on every path.
      const configurationIndex = statements.findIndex((statement) => {
        const call = directAwaitedCall(statement);
        const callee =
          call === undefined ? null : unwrapExpression(call.callee);
        return (
          call !== undefined &&
          isIdentifierReference(callee) &&
          callee.name === "configureReadTransaction" &&
          resolveVariable(context, callee) === configurationBinding &&
          takesTransaction(call)
        );
      });
      const configuration = statements.at(configurationIndex);
      if (configurationIndex === -1 || configuration === undefined) {
        return false;
      }
      const unconfiguredInvocations: AstNode[] = [];
      walkOwnFunctionBody(callback, (node) => {
        if (
          invokesSharedCallback(node) &&
          (!takesTransaction(node) || node.range[0] < configuration.range[1])
        ) {
          unconfiguredInvocations.push(node);
        }
      });
      return (
        unconfiguredInvocations.length === 0 &&
        statements.slice(configurationIndex + 1).some((statement) => {
          if (statement.type !== "ReturnStatement") {
            return false;
          }
          const returned = unwrapExpression(statement.argument);
          const call =
            returned?.type === "AwaitExpression"
              ? unwrapExpression(returned.argument)
              : returned;
          return invokesSharedCallback(call) && takesTransaction(call);
        })
      );
    })
  );
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
                !invokesInOwnBody(functionNode, context)
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
            "publicLawReadDb must configure the read transaction unconditionally before invoking fn(tx).",
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
              !transactionsAreConfigured(context, publicLawReadFunction)
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
