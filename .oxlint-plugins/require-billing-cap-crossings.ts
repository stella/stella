import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  isImportedFrom,
  memberPropertyName,
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
const RECONCILIATION_EXPORTS = new Set(["recordBillingCapCrossings"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const templateText = (quasi: unknown) => {
  if (!isAstNode(quasi)) {
    return "";
  }
  const value = quasi.value;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

const reconciledAfter = (context: RuleContext, mutation: AstNode) => {
  if (
    !isAstNode(mutation.callee) ||
    !isIdentifierReference(mutation.callee.object)
  ) {
    return false;
  }
  const transaction = resolveVariable(context, mutation.callee.object);
  if (!transaction) {
    return false;
  }
  let owner = isAstNode(mutation.parent) ? mutation.parent : null;
  while (owner && !FUNCTION_TYPES.has(owner.type)) {
    owner = isAstNode(owner.parent) ? owner.parent : null;
  }
  const body = owner && isAstNode(owner.body) ? owner.body : null;
  if (!body) {
    return false;
  }
  const visit = (node: AstNode): boolean => {
    if (FUNCTION_TYPES.has(node.type)) {
      return false;
    }
    if (
      node.type === "AwaitExpression" &&
      node.range[0] > mutation.range[1] &&
      isAstNode(node.argument)
    ) {
      const call = node.argument;
      const argument = Array.isArray(call.arguments)
        ? call.arguments.at(0)
        : null;
      if (
        call.type === "CallExpression" &&
        isImportedFrom({
          context,
          node: call.callee,
          modules: ["apps/api/src/lib/billing/arrangements"],
          names: RECONCILIATION_EXPORTS,
        }) &&
        isIdentifierReference(argument) &&
        resolveVariable(context, argument) === transaction
      ) {
        return true;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "parent") {
        continue;
      }
      if (isAstNode(child) && visit(child)) {
        return true;
      }
      if (
        Array.isArray(child) &&
        child.some((item) => isAstNode(item) && visit(item))
      ) {
        return true;
      }
    }
    return false;
  };
  return visit(body);
};

export default eslintCompatPlugin({
  meta: { name: "require-billing-cap-crossings" },
  rules: {
    "require-billing-cap-crossings": {
      meta: {
        type: "problem",
        messages: {
          missingReconciliation:
            "Await recordBillingCapCrossings with this transaction after changing time entries so approved-value changes reconcile cap crossings.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (
              !isAstNode(node) ||
              !isAstNode(node.callee) ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            const method = memberPropertyName(node.callee);
            const table = node.arguments.at(0);
            const directMutation =
              (method === "update" || method === "delete") &&
              isImportedFrom({
                context,
                node: table,
                modules: SCHEMA_MODULES,
                names: ENTRY_EXPORTS,
              });
            const template =
              isAstNode(table) &&
              table.type === "TaggedTemplateExpression" &&
              isAstNode(table.quasi)
                ? table.quasi
                : null;
            const sqlText =
              template && Array.isArray(template.quasis)
                ? template.quasis.map(templateText).join(" ")
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
            if (
              (directMutation || rawMutation) &&
              !reconciledAfter(context, node)
            ) {
              context.report({ node, messageId: "missingReconciliation" });
            }
          },
        };
      },
    },
  },
});
