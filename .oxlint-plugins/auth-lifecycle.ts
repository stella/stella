// Authentication lifecycle operations share one transaction.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  type ImportedFromOptions,
  everyNode,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isFileIn,
  isIdentifier,
  isImportedFrom,
  memberPropertyName,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const HELPER: ReadonlySet<string> = new Set([
  "removeOrganizationMemberWithAuthArtifacts",
]);
const REMOVAL_HELPERS: ReadonlySet<string> = new Set([
  "removeOrganizationMemberWithAuthArtifacts",
  "revokeOrganizationMemberAuthArtifacts",
]);
const HELPER_MODULE = "apps/api/src/lib/auth-artifacts";
// The organization offboarding operation ends with the helper above, in the
// same transaction, so it satisfies the hook on its behalf.
const OFFBOARDING_HELPER: ReadonlySet<string> = new Set([
  "removeOrganizationMemberInTransaction",
]);
const OFFBOARDING_MODULE = "apps/api/src/lib/member-assignment-offboarding";
const HELPER_FILE = "apps/api/src/lib/auth-artifacts.ts";
const AUTH_SCHEMA_MODULE = "apps/api/src/db/auth-schema";
const AUTH_ARTIFACT_TABLES: ReadonlySet<string> = new Set([
  "oauthAccessToken",
  "oauthRefreshToken",
  "session",
]);
// `authSchema.session`: the schema module also exports its tables as one
// object.
const AUTH_SCHEMA_OBJECT: ReadonlySet<string> = new Set(["authSchema"]);

const ROOT_MODULE = "apps/api/src/db/root";
const ROOT_DATABASE: ReadonlySet<string> = new Set(["rootDb"]);

const containsReachableReturn = (root: AstNode): boolean =>
  everyNode(root).some((node) => {
    if (node.type !== "ReturnStatement") {
      return false;
    }
    let child = node;
    let parent = node.parent;
    while (isAstNode(parent)) {
      if (
        parent.type === "ArrowFunctionExpression" ||
        parent.type === "FunctionExpression" ||
        parent.type === "FunctionDeclaration"
      ) {
        return false;
      }
      if (parent.type === "IfStatement") {
        const test = unwrapExpression(parent.test);
        if (
          test?.type === "Literal" &&
          ((Boolean(test.value) && parent.alternate === child) ||
            (!test.value && parent.consequent === child))
        ) {
          return false;
        }
      }
      const statements = Array.isArray(parent.body) ? parent.body : null;
      if (
        statements?.includes(child) &&
        statements
          .slice(0, statements.indexOf(child))
          .some(
            (statement) =>
              isAstNode(statement) &&
              (statement.type === "ReturnStatement" ||
                statement.type === "ThrowStatement"),
          )
      ) {
        return false;
      }
      if (parent === root) {
        return true;
      }
      child = parent;
      parent = parent.parent;
    }
    return node === root;
  });

// `const x = await ...`: the single initializer of a one-binding declaration.
const declaredValue = (statement: AstNode): AstNode | null => {
  if (
    !Array.isArray(statement.declarations) ||
    statement.declarations.length !== 1
  ) {
    return null;
  }
  const declarator: unknown = statement.declarations.at(0);
  return isAstNode(declarator) ? unwrapExpression(declarator.init) : null;
};

// `Result.tryPromise({ try: async () => ... })` runs its `try` callback
// unconditionally; its direct calls count as the hook's own.
const tryPromiseCalls = (call: AstNode): AstNode[] => {
  const callee = unwrapExpression(call.callee);
  if (
    callee?.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "tryPromise" ||
    !isIdentifier(callee.object, "Result") ||
    !Array.isArray(call.arguments)
  ) {
    return [];
  }
  const options = unwrapExpression(call.arguments.at(0));
  if (
    options?.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return [];
  }
  const attempt: unknown = options.properties.find(
    (property: unknown) =>
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "try",
  );
  const callback = isAstNode(attempt) ? unwrapExpression(attempt.value) : null;
  return callback !== null &&
    (callback.type === "ArrowFunctionExpression" ||
      callback.type === "FunctionExpression")
    ? directCalls(callback.body)
    : [];
};

const directCalls = (root: unknown): AstNode[] => {
  const expression = unwrapExpression(root);
  if (expression === null) {
    return [];
  }
  if (expression.type !== "BlockStatement") {
    const call =
      expression.type === "AwaitExpression"
        ? unwrapExpression(expression.argument)
        : expression;
    return call?.type === "CallExpression" ? [call] : [];
  }
  const calls: AstNode[] = [];
  if (!Array.isArray(expression.body)) {
    return calls;
  }
  for (const statement of expression.body) {
    if (!isAstNode(statement)) {
      continue;
    }
    const value =
      statement.type === "ExpressionStatement"
        ? unwrapExpression(statement.expression)
        : statement.type === "ReturnStatement"
          ? unwrapExpression(statement.argument)
          : statement.type === "VariableDeclaration"
            ? declaredValue(statement)
            : null;
    const call =
      value?.type === "AwaitExpression"
        ? unwrapExpression(value.argument)
        : statement.type === "ReturnStatement"
          ? value
          : null;
    if (call?.type === "CallExpression") {
      calls.push(call);
    }
    if (
      statement.type === "ReturnStatement" ||
      statement.type === "ThrowStatement"
    ) {
      break;
    }
    // A successful early exit skips the operation; an exception aborts the transaction.
    if (containsReachableReturn(statement)) {
      break;
    }
  }
  return calls;
};

const containsTransactionalRemoval = (
  context: RuleContext,
  root: unknown,
): boolean => {
  const hook = unwrapExpression(root);
  if (
    hook === null ||
    (hook.type !== "ArrowFunctionExpression" &&
      hook.type !== "FunctionExpression")
  ) {
    return false;
  }
  return directCalls(hook.body)
    .flatMap((call) => [call].concat(tryPromiseCalls(call)))
    .some((call) => {
      const callee = unwrapExpression(call.callee);
      if (
        callee?.type !== "MemberExpression" ||
        memberPropertyName(callee) !== "transaction" ||
        !isImportedFrom({
          context,
          node: callee.object,
          modules: [ROOT_MODULE],
          names: ROOT_DATABASE,
        }) ||
        !Array.isArray(call.arguments)
      ) {
        return false;
      }
      const callback = unwrapExpression(call.arguments.at(0));
      if (
        callback === null ||
        (callback.type !== "ArrowFunctionExpression" &&
          callback.type !== "FunctionExpression") ||
        callback.async !== true ||
        !Array.isArray(callback.params)
      ) {
        return false;
      }
      const transaction = callback.params.at(0);
      if (!isIdentifier(transaction)) {
        return false;
      }
      return directCalls(callback.body).some((operation) => {
        if (
          !Array.isArray(operation.arguments) ||
          !isIdentifier(operation.arguments.at(0), transaction.name)
        ) {
          return false;
        }
        return (
          isImportedFrom({
            context,
            node: invokedCallee(operation),
            modules: [HELPER_MODULE],
            names: HELPER,
          }) ||
          isImportedFrom({
            context,
            node: invokedCallee(operation),
            modules: [OFFBOARDING_MODULE],
            names: OFFBOARDING_HELPER,
          })
        );
      });
    });
};

// The auth artifact table a `<receiver>.delete(<table>)` call targets.
const deletedAuthTable = (
  context: RuleContext,
  node: unknown,
): string | null => {
  const call = unwrapExpression(node);
  const callee =
    call?.type === "CallExpression" ? unwrapExpression(call.callee) : null;
  if (
    call === null ||
    callee?.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "delete" ||
    !Array.isArray(call.arguments)
  ) {
    return null;
  }
  const table = unwrapExpression(call.arguments.at(0));
  if (table === null) {
    return null;
  }
  const direct = resolveImport(context, table);
  if (direct !== null) {
    return direct.moduleId === AUTH_SCHEMA_MODULE &&
      AUTH_ARTIFACT_TABLES.has(direct.imported)
      ? direct.imported
      : null;
  }
  if (table.type !== "MemberExpression") {
    return null;
  }
  const property = memberPropertyName(table);
  return property !== null &&
    AUTH_ARTIFACT_TABLES.has(property) &&
    isImportedFrom({
      context,
      node: table.object,
      modules: [AUTH_SCHEMA_MODULE],
      names: AUTH_SCHEMA_OBJECT,
    })
    ? property
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "auth-lifecycle" },
  rules: {
    "member-removal-revokes-artifacts": {
      meta: {
        type: "problem",
        messages: {
          missingAuthArtifactCleanup:
            "beforeRemoveMember must await removeOrganizationMemberWithAuthArtifacts(...) inside rootDb.transaction(...).",
        },
      },
      createOnce(context) {
        const organizationHooks: AstNode[] = [];
        return {
          before() {
            organizationHooks.length = 0;
          },
          Property(node) {
            const hookName = getPropertyName(node.key);
            if (
              hookName === "organizationHooks" &&
              isAstNode(node) &&
              isAstNode(node.value) &&
              node.value.type === "ObjectExpression"
            ) {
              organizationHooks.push(node);
              return;
            }
            if (
              hookName !== "beforeRemoveMember" &&
              hookName !== "afterRemoveMember"
            ) {
              return;
            }

            if (
              hookName === "afterRemoveMember" &&
              (!isAstNode(node.value) ||
                !everyNode(node.value).some(
                  (call) =>
                    call.type === "CallExpression" &&
                    isImportedFrom({
                      context,
                      node: invokedCallee(call),
                      modules: [HELPER_MODULE],
                      names: REMOVAL_HELPERS,
                    }),
                ))
            ) {
              return;
            }

            if (
              hookName === "beforeRemoveMember" &&
              containsTransactionalRemoval(context, node.value)
            ) {
              return;
            }

            context.report({
              node,
              messageId: "missingAuthArtifactCleanup",
            });
          },
          "Program:exit"() {
            for (const node of organizationHooks) {
              if (
                isAstNode(node.value) &&
                Array.isArray(node.value.properties) &&
                node.value.properties.some(
                  (property) =>
                    isAstNode(property) &&
                    property.type === "Property" &&
                    getPropertyName(property.key) === "beforeRemoveMember",
                )
              ) {
                continue;
              }
              context.report({
                node,
                messageId: "missingAuthArtifactCleanup",
              });
            }
          },
        };
      },
    },

    "no-direct-auth-artifact-delete": {
      meta: {
        type: "problem",
        messages: {
          directAuthArtifactDelete:
            "Delete org-member auth artifacts through revokeOrganizationMemberAuthArtifacts(...), not by deleting {{table}} directly.",
        },
      },
      createOnce(context) {
        let allowedFile = false;

        return {
          before() {
            allowedFile = isFileIn(context, [HELPER_FILE]);
          },
          CallExpression(node) {
            if (allowedFile) {
              return;
            }

            const table = deletedAuthTable(context, node);
            if (table === null) {
              return;
            }

            context.report({
              node,
              messageId: "directAuthArtifactDelete",
              data: { table },
            });
          },
        };
      },
    },
  },
});
