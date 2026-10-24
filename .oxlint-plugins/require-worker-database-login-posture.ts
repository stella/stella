import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  filenameForContext,
  getPropertyName,
  type ImportedFromOptions,
  invokedCallee,
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  isSingleAssignment,
  isTestFile,
  resolveVariable,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];
const HOST_EXPORTS = new Set(["createBullMqWorkerHost"]);
const POSTURE_EXPORTS = new Set(["assertDatabaseLoginPosture"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const guardedBefore = (context: RuleContext, host: AstNode) => {
  const options = Array.isArray(host.arguments) ? host.arguments.at(1) : null;
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return false;
  }
  if (
    options.properties.some(
      (property) =>
        !isAstNode(property) ||
        property.type !== "Property" ||
        property.computed === true,
    )
  ) {
    return false;
  }
  const dbProperties = options.properties.filter(
    (property) =>
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "db",
  );
  if (dbProperties.length !== 1) {
    return false;
  }
  const dbProperty = dbProperties.at(0);
  if (!isAstNode(dbProperty) || !isIdentifierReference(dbProperty.value)) {
    return false;
  }
  const db = resolveVariable(context, dbProperty.value);
  if (!db || !isSingleAssignment(db)) {
    return false;
  }

  let block = isAstNode(host.parent) ? host.parent : null;
  while (block && block.type !== "BlockStatement" && block.type !== "Program") {
    if (FUNCTION_TYPES.has(block.type)) {
      return false;
    }
    block = isAstNode(block.parent) ? block.parent : null;
  }
  if (!block || !Array.isArray(block.body)) {
    return false;
  }
  return block.body.some((statement) => {
    if (
      !isAstNode(statement) ||
      statement.type !== "ExpressionStatement" ||
      statement.range[1] >= host.range[0] ||
      !isAstNode(statement.expression) ||
      statement.expression.type !== "AwaitExpression"
    ) {
      return false;
    }
    const call = statement.expression.argument;
    if (
      !isAstNode(call) ||
      call.type !== "CallExpression" ||
      !Array.isArray(call.arguments) ||
      !isImportedFrom({
        context,
        node: call.callee,
        modules: ["apps/api/src/lib/db/assert-database-login-posture"],
        names: POSTURE_EXPORTS,
      })
    ) {
      return false;
    }
    const checkedDb = call.arguments.at(0);
    return (
      isIdentifierReference(checkedDb) &&
      resolveVariable(context, checkedDb) === db
    );
  });
};

export default eslintCompatPlugin({
  meta: { name: "require-worker-database-login-posture" },
  rules: {
    "require-worker-database-login-posture": {
      meta: {
        type: "problem",
        messages: {
          missingPosture:
            "Await assertDatabaseLoginPosture for the host's database in a preceding statement in the same block before creating a worker host.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (
              !isAstNode(node) ||
              isTestFile(filenameForContext(context)) ||
              !isImportedFrom({
                context,
                node: invokedCallee(node),
                modules: ["apps/api/src/lib/bullmq-queue"],
                names: HOST_EXPORTS,
              })
            ) {
              return;
            }
            if (!guardedBefore(context, node)) {
              context.report({ node, messageId: "missingPosture" });
            }
          },
        };
      },
    },
  },
});
