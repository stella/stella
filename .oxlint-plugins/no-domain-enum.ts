// Domain values stay visible to TypeScript and runtime consumers as string
// literal unions or `as const` lookup tables. TypeScript enums emit runtime
// objects and create a second representation of the same domain vocabulary.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  resolveImportedExpressionForEnforcement,
  staticStringValue,
} from "./utils.ts";

const PG_CORE = "drizzle-orm/pg-core";

export default eslintCompatPlugin({
  meta: { name: "no-domain-enum" },
  rules: {
    "no-domain-enum": {
      meta: {
        type: "problem",
        messages: {
          forbidden:
            "Use a string-literal union or an `as const` lookup table instead of a TypeScript enum.",
          pgEnum:
            "Use a named `as const` value list with `text({ enum: VALUES })` instead of `pgEnum`.",
        },
      },
      createOnce(context) {
        return {
          TSEnumDeclaration(node) {
            context.report({ node, messageId: "forbidden" });
          },
          ImportDeclaration(node) {
            if (node.source.value !== PG_CORE || node.importKind === "type") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.importKind !== "type" &&
                getImportedName(specifier) === "pgEnum"
              ) {
                context.report({ node: specifier, messageId: "pgEnum" });
              }
            }
          },
          MemberExpression(node) {
            const imported = resolveImportedExpressionForEnforcement(
              context,
              node,
            );
            if (
              imported?.source === PG_CORE &&
              imported.imported === "pgEnum"
            ) {
              context.report({ node, messageId: "pgEnum" });
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== "ObjectPattern") {
              return;
            }
            const imported = resolveImportedExpressionForEnforcement(
              context,
              node.init,
            );
            if (imported?.source !== PG_CORE || imported.imported !== "*") {
              return;
            }
            for (const property of node.id.properties) {
              if (
                isAstNode(property) &&
                property.type === "Property" &&
                (property.computed
                  ? staticStringValue(property.key)
                  : getPropertyName(property.key)) === "pgEnum"
              ) {
                context.report({ node: property, messageId: "pgEnum" });
              }
            }
          },
        };
      },
    },
  },
});
