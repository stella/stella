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

import { PUBLIC_READ_TRANSPORTS } from "../apps/api/src/lib/legal-search/public-read-transports.ts";
import {
  PUBLIC_READ_SERVING_ROOTS,
  publicReadIoCallMethod,
  publicReadIoMethod,
  publicReadIoMethodKind,
  publicReadIoWrapper,
} from "./public-read-io-provenance.ts";
import {
  canonicalModuleId,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  isSingleAssignment,
  isStringLiteral,
  memberPropertyName,
  repoRelativeFilename,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const OUTBOUND_REQUEST_CALLERS = new Map([
  [
    "fetchPublicReadRequest",
    "apps/api/src/lib/legal-search/public-read-timeout-context.ts",
  ],
  ["outboundRequests", "apps/api/src/lib/auth/authorized-outbound-fetch.ts"],
]);

const ALTERNATE_READERS = new Set([
  "readPublicDecisionLanguageAlternatesByGroup",
]);

const SEARCH_FUNCTIONS = new Set([
  "searchPostgresDecisions",
  "searchCorpusIndexDecisions",
  "listCaseLawProvisionDecisions",
]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isFunctionLike = (node: unknown): node is AstNode =>
  isAstNode(node) && FUNCTION_TYPES.has(node.type);

const isRawExportReference = (node: AstNode): boolean => {
  let parent = node.parent;
  while (isAstNode(parent)) {
    if (FUNCTION_TYPES.has(parent.type)) {
      return false;
    }
    if (
      parent.type === "ExportNamedDeclaration" ||
      parent.type === "ExportDefaultDeclaration"
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

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
  context: ImportResolutionContext,
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
  let observationBinding: Variable | null = null;
  let scope = context.sourceCode.getScope(sharedParameter);
  while (true) {
    if (scope.type === "module" || scope.type === "global") {
      configurationBinding = scope.set.get("configureReadTransaction") ?? null;
      observationBinding =
        scope.set.get("observePublicLawReadTransaction") ?? null;
      break;
    }
    if (scope.upper === null) {
      break;
    }
    scope = scope.upper;
  }
  if (
    configurationBinding === null ||
    !isSingleAssignment(configurationBinding)
  ) {
    return false;
  }
  const transactions: AstNode[] = [];
  const collectTransactions = (ownerFunction: AstNode) => {
    walkOwnFunctionBody(ownerFunction, (node) => {
      if (
        isMemberCall(node, "transaction") ||
        publicReadIoMethodKind(
          publicReadIoMethod(context, node.callee)?.method ?? null,
        ) === "database"
      ) {
        transactions.push(node);
      }
      if (node.type !== "CallExpression" || !Array.isArray(node.arguments)) {
        return;
      }
      const callback = unwrapExpression(node.arguments.at(1));
      if (
        publicReadIoWrapper(context, node)?.transport === "database" &&
        callback !== null
      ) {
        collectTransactions(callback);
      }
    });
  };
  collectTransactions(functionNode);
  return (
    transactions.length > 0 &&
    transactions.every((transaction) => {
      const scoped = publicReadIoMethod(context, transaction.callee);
      const callback = unwrapExpression(
        publicReadIoMethodKind(scoped?.method ?? null) === "database" &&
          Array.isArray(transaction.arguments)
          ? transaction.arguments.at(1)
          : firstArgument(transaction),
      );
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
        if (!isIdentifierReference(argument)) {
          return false;
        }
        if (resolveVariable(context, argument) === transactionBinding) {
          return true;
        }
        const alias = resolveVariable(context, argument);
        const definition = alias?.defs.at(0)?.node;
        if (
          alias === null ||
          observationBinding === null ||
          !isSingleAssignment(observationBinding) ||
          !isSingleAssignment(alias) ||
          !isAstNode(definition) ||
          definition.type !== "VariableDeclarator"
        ) {
          return false;
        }
        const initializer = unwrapExpression(definition.init);
        if (initializer?.type !== "CallExpression") {
          return false;
        }
        const callee = unwrapExpression(initializer.callee);
        const observedTransaction = unwrapExpression(
          firstArgument(initializer),
        );
        return (
          isIdentifierReference(callee) &&
          resolveVariable(context, callee) === observationBinding &&
          isIdentifierReference(observedTransaction) &&
          resolveVariable(context, observedTransaction) === transactionBinding
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

const PUBLIC_READ_CONTEXT_OWNER =
  "apps/api/src/lib/legal-search/public-read-timeout-context";
const PUBLIC_READ_OWNER_KINDS = new Map(
  Object.entries(PUBLIC_READ_TRANSPORTS).flatMap(([kind, paths]) =>
    paths.map((path) => [path, kind] as const),
  ),
);
const RAW_FETCH_MODULES = new Map([
  ["@stll/fetch", new Set(["fetchWithTimeout", "createFetchWithTimeout"])],
  [
    "packages/fetch/src",
    new Set(["fetchWithTimeout", "createFetchWithTimeout"]),
  ],
  ["undici", new Set(["fetch", "request", "stream"])],
  ["node:http", new Set(["request", "get"])],
  ["node:https", new Set(["request", "get"])],
]);

const isRawPublicReadFetch = (
  context: ImportResolutionContext,
  node: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const callee = unwrapExpression(node);
  if (callee === null || seen.has(callee)) {
    return false;
  }
  seen.add(callee);
  if (callee.type === "CallExpression") {
    const bound = unwrapExpression(callee.callee);
    return bound?.type === "MemberExpression" &&
      memberPropertyName(bound) === "bind"
      ? isRawPublicReadFetch(context, bound.object, seen)
      : false;
  }
  const binding = resolveImport(context, callee);
  if (
    binding !== null &&
    RAW_FETCH_MODULES.get(binding.moduleId)?.has(binding.imported)
  ) {
    return true;
  }
  if (isIdentifierReference(callee)) {
    const variable = resolveVariable(context, callee);
    if (callee.name === "fetch" && (variable?.defs.length ?? 0) === 0) {
      return true;
    }
    return (
      variable !== null &&
      isRawPublicReadFetch(context, stableInitializer(variable), seen)
    );
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === "call" || method === "apply" || method === "bind") {
    return isRawPublicReadFetch(context, callee.object, seen);
  }
  if (method !== "fetch") {
    return false;
  }
  const receiver = unwrapExpression(callee.object);
  return (
    isIdentifierReference(receiver) &&
    receiver.name === "globalThis" &&
    (resolveVariable(context, receiver)?.defs.length ?? 0) === 0
  );
};

export default eslintCompatPlugin({
  meta: { name: "public-law-read-boundary" },
  rules: {
    "require-owned-public-read-transport": {
      meta: {
        type: "problem",
        messages: {
          unownedTransport:
            "Public-read I/O must use a handle issued by withPublicReadIo() for this transport; raw fetch and transaction calls cannot own transport settlement.",
          missingOwner:
            "The registered {{transport}} transport must invoke its canonical withPublicReadIo() scope.",
          confinedRequest:
            "Raw outbound request primitives may only be used by their canonical scope or permit facade.",
          wrongOwner:
            "This transport owner must use its registered {{transport}} kind.",
        },
      },
      createOnce(context) {
        let expected: string | undefined;
        let checksTransport = false;
        let isContextOwner = false;
        const observed = new Set<string>();
        const checkForwarder = (node: AstNode): void => {
          const imported = resolveImport(context, node);
          if (
            imported?.moduleId === "apps/api/src/lib/safe-outbound-fetch" &&
            OUTBOUND_REQUEST_CALLERS.has(imported.imported) &&
            (OUTBOUND_REQUEST_CALLERS.get(imported.imported) !==
              repoRelativeFilename(context) ||
              isRawExportReference(node))
          ) {
            context.report({ node, messageId: "confinedRequest" });
          }
        };
        return {
          before() {
            observed.clear();
            const filename = repoRelativeFilename(context);
            expected = PUBLIC_READ_OWNER_KINDS.get(filename);
            isContextOwner = filename === `${PUBLIC_READ_CONTEXT_OWNER}.ts`;
            checksTransport =
              !isContextOwner &&
              (expected !== undefined ||
                filename.endsWith("public-law-read-boundary.fixture.ts") ||
                PUBLIC_READ_SERVING_ROOTS.some((root) =>
                  filename.startsWith(root),
                ));
            return (
              checksTransport ||
              /safe-outbound-fetch/u.test(context.sourceCode.text)
            );
          },
          "ExportNamedDeclaration, ExportAllDeclaration"(node) {
            if (
              !isAstNode(node) ||
              !isStringLiteral(node.source) ||
              canonicalModuleId(
                node.source.value,
                repoRelativeFilename(context),
              ) !== "apps/api/src/lib/safe-outbound-fetch"
            ) {
              return;
            }
            if (
              node.type === "ExportAllDeclaration" ||
              (Array.isArray(node.specifiers) &&
                node.specifiers.some(
                  (specifier) =>
                    isAstNode(specifier) &&
                    OUTBOUND_REQUEST_CALLERS.has(
                      getPropertyName(specifier.local) ?? "",
                    ),
                ))
            ) {
              context.report({ node, messageId: "confinedRequest" });
            }
          },
          ImportSpecifier(node) {
            if (isAstNode(node) && isAstNode(node.local)) {
              checkForwarder(node.local);
            }
          },
          Identifier(node) {
            if (
              isAstNode(node) &&
              (!isAstNode(node.parent) ||
                (node.parent.type !== "ImportSpecifier" &&
                  !(
                    node.parent.type === "VariableDeclarator" &&
                    node.parent.id === node
                  )))
            ) {
              checkForwarder(node);
            }
          },
          MemberExpression(node) {
            if (isAstNode(node)) {
              checkForwarder(node);
            }
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (!checksTransport) {
              return;
            }
            const wrapper = publicReadIoWrapper(context, node);
            if (wrapper !== null) {
              observed.add(wrapper.transport);
              if (expected !== undefined && wrapper.transport !== expected) {
                context.report({
                  node,
                  messageId: "wrongOwner",
                  data: { transport: expected },
                });
              }
              return;
            }
            const callee = invokedCallee(node);
            const method = publicReadIoCallMethod(context, callee);
            const owned = publicReadIoMethod(context, callee);
            if (owned !== null) {
              return;
            }
            if (
              isRawPublicReadFetch(context, callee) ||
              publicReadIoMethodKind(method) === "http" ||
              (expected !== undefined &&
                (method === "transaction" ||
                  publicReadIoMethodKind(method) === "database"))
            ) {
              context.report({ node, messageId: "unownedTransport" });
            }
          },
          "Program:exit"(node) {
            if (expected !== undefined && !observed.has(expected)) {
              context.report({
                node,
                messageId: "missingOwner",
                data: { transport: expected },
              });
            }
          },
        };
      },
    },
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
          // createOnce keeps this closure across files: start each file empty.
          before() {
            functions.clear();
          },
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
          // createOnce keeps this closure across files: start each file empty.
          before() {
            publicLawReadFunction = null;
          },
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
