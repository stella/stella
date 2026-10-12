import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  canonicalModuleId,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  repoRelativeFilename,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const SQL_CLOSE_OWNER = "apps/api/src/db/sql-close";

export default eslintCompatPlugin({
  meta: { name: "confine-sql-close" },
  rules: {
    "confine-sql-close": {
      meta: {
        type: "problem",
        messages: {
          rawCloseBudget:
            "Use forceClosePool or terminateReserved from @/api/db/sql-close instead of a raw SQL close budget; pool and reserved connections have different driver semantics.",
        },
        schema: [],
      },
      createOnce(context) {
        const resolveLocal = (input: unknown, seen = new Set<Variable>()) => {
          let node = unwrapExpression(input);
          while (isIdentifierReference(node)) {
            const variable = resolveVariable(context, node);
            if (variable === null || seen.has(variable)) {
              return node;
            }
            seen.add(variable);
            const initializer = stableInitializer(variable);
            if (initializer === null) {
              return node;
            }
            node = unwrapExpression(initializer);
          }
          return node;
        };
        const hasCloseBudget = (
          input: unknown,
          seen = new Set<Variable>(),
        ): boolean => {
          const options = resolveLocal(input, seen);
          if (
            options?.type !== "ObjectExpression" ||
            !Array.isArray(options.properties)
          ) {
            return false;
          }
          return options.properties.some((property) => {
            if (!isAstNode(property)) {
              return false;
            }
            if (property.type === "SpreadElement") {
              return hasCloseBudget(property.argument, new Set(seen));
            }
            if (property.type !== "Property") {
              return false;
            }
            const name = property.computed
              ? staticStringValue(property.key)
              : getPropertyName(property.key);
            return name === "timeout";
          });
        };
        return {
          before() {
            const filename = repoRelativeFilename(context);
            return canonicalModuleId(filename, filename) !== SQL_CLOSE_OWNER;
          },
          Property(node) {
            const name = node.computed
              ? staticStringValue(node.key)
              : getPropertyName(node.key);
            if (name === "closeTimeout") {
              context.report({ node, messageId: "rawCloseBudget" });
            }
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (
              target?.type === "MemberExpression" &&
              memberPropertyName(target) === "closeTimeout"
            ) {
              context.report({ node, messageId: "rawCloseBudget" });
            }
          },
          CallExpression(node) {
            const callee = resolveLocal(node.callee);
            if (
              callee?.type === "MemberExpression" &&
              memberPropertyName(callee) === "close" &&
              hasCloseBudget(node.arguments.at(0))
            ) {
              context.report({ node, messageId: "rawCloseBudget" });
            }
          },
        };
      },
    },
  },
});
