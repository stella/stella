import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifier,
  isImportedFrom,
  memberPropertyName,
  getPropertyName,
  resolveVariable,
  type AstNode,
  type ImportedFromOptions,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];
const SCHEMA_MODULES = [
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/billing",
];
const ENTRY_EXPORTS = new Set(["timeEntries"]);
const GUARD_EXPORTS = new Set(["guardRunningTimeEntries"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

type GuardTransactionOptions = { call: AstNode; mutation: AstNode };
const guardsSameTransaction = (
  context: RuleContext,
  { call, mutation }: GuardTransactionOptions,
) => {
  const args = Array.isArray(call.arguments) ? call.arguments.at(0) : null;
  if (
    !isAstNode(args) ||
    args.type !== "ObjectExpression" ||
    !Array.isArray(args.properties) ||
    !isAstNode(mutation.callee)
  ) {
    return false;
  }
  const txProperty = args.properties.find(
    (property) =>
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "tx",
  );
  if (
    !isAstNode(txProperty) ||
    !isIdentifier(txProperty.value) ||
    !isIdentifier(mutation.callee.object)
  ) {
    return false;
  }
  const guardedTx = resolveVariable(context, txProperty.value);
  if (
    !guardedTx ||
    guardedTx !== resolveVariable(context, mutation.callee.object)
  ) {
    return false;
  }
  return true;
};

const guardedBefore = (context: RuleContext, mutation: AstNode) => {
  let parent = isAstNode(mutation.parent) ? mutation.parent : null;
  while (parent && !FUNCTION_TYPES.has(parent.type)) {
    parent = isAstNode(parent.parent) ? parent.parent : null;
  }
  const body = parent && isAstNode(parent.body) ? parent.body : null;
  if (body?.type !== "BlockStatement" || !Array.isArray(body.body)) {
    return false;
  }
  return body.body.some((statement, index) => {
    if (
      !isAstNode(statement) ||
      statement.type !== "VariableDeclaration" ||
      statement.range[1] >= mutation.range[0] ||
      !Array.isArray(statement.declarations)
    ) {
      return false;
    }
    const declaration = statement.declarations.at(0);
    if (
      !isAstNode(declaration) ||
      !isIdentifier(declaration.id) ||
      !isAstNode(declaration.init) ||
      declaration.init.type !== "AwaitExpression"
    ) {
      return false;
    }
    const call = declaration.init.argument;
    if (
      !isAstNode(call) ||
      call.type !== "CallExpression" ||
      !isImportedFrom({
        context,
        node: call.callee,
        modules: ["apps/api/src/lib/billing/time-entry-running"],
        names: GUARD_EXPORTS,
      })
    ) {
      return false;
    }
    if (!guardsSameTransaction(context, { call, mutation })) {
      return false;
    }
    const refusal = body.body.at(index + 1);
    if (
      !isAstNode(refusal) ||
      refusal.type !== "IfStatement" ||
      refusal.range[1] >= mutation.range[0] ||
      !isIdentifier(refusal.test, declaration.id.name)
    ) {
      return false;
    }
    const consequence = refusal.consequent;
    if (!isAstNode(consequence)) {
      return false;
    }
    if (consequence.type === "ReturnStatement") {
      return true;
    }
    if (
      consequence.type !== "BlockStatement" ||
      !Array.isArray(consequence.body) ||
      consequence.body.length !== 1
    ) {
      return false;
    }
    const returned = consequence.body.at(0);
    return isAstNode(returned) && returned.type === "ReturnStatement";
  });
};

export default eslintCompatPlugin({
  meta: { name: "require-running-entry-guard" },
  rules: {
    "require-running-entry-guard": {
      meta: {
        type: "problem",
        messages: {
          missingGuard:
            "Await guardRunningTimeEntries in this mutation's transaction and return on refusal before changing time entries.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (!isAstNode(node.callee) || !Array.isArray(node.arguments)) {
              return;
            }
            const method = memberPropertyName(node.callee);
            const table = node.arguments.at(0);
            const importedTable = isImportedFrom({
              context,
              node: table,
              modules: SCHEMA_MODULES,
              names: ENTRY_EXPORTS,
            });
            const directMutation =
              (method === "update" || method === "delete") && importedTable;
            const template =
              isAstNode(table) &&
              table.type === "TaggedTemplateExpression" &&
              isAstNode(table.quasi)
                ? table.quasi
                : null;
            const sqlText =
              template && Array.isArray(template.quasis)
                ? template.quasis
                    .map((quasi) =>
                      isAstNode(quasi) &&
                      typeof quasi.value === "object" &&
                      quasi.value !== null
                        ? Reflect.get(quasi.value, "raw")
                        : "",
                    )
                    .join(" ")
                : "";
            const interpolatedEntry =
              template &&
              Array.isArray(template.expressions) &&
              template.expressions.some((expression) =>
                isImportedFrom({
                  context,
                  node: expression,
                  modules: SCHEMA_MODULES,
                  names: ENTRY_EXPORTS,
                }),
              );
            const rawMutation =
              method === "execute" &&
              /\b(?:UPDATE|DELETE\s+FROM)\b/iu.test(sqlText) &&
              (/\btime_entries\b/iu.test(sqlText) || interpolatedEntry);
            if (!directMutation && !rawMutation) {
              return;
            }
            if (!guardedBefore(context, node)) {
              context.report({ node, messageId: "missingGuard" });
            }
          },
        };
      },
    },
  },
});
