import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RAW_FETCH_EXPORTS = new Set(["fetchWithTimeout", "fetch"]);
const NODE_HTTP_MODULES = new Set(["http", "https", "node:http", "node:https"]);
const NODE_HTTP_EXPORTS = new Set(["get", "request"]);
const OWNER_EXPORTS = new Set([
  "politePublisherFetch",
  "createPolitePublisherFetch",
]);

export default eslintCompatPlugin({
  meta: { name: "require-polite-publisher-fetch" },
  rules: {
    "require-polite-publisher-fetch": {
      meta: {
        type: "problem",
        messages: {
          rawPublisherRequest:
            "Publisher HTTP requests must go through politePublisherFetch so robots.txt and crawl delay are enforced.",
        },
      },
      createOnce(context) {
        const isGlobalReference = (identifier: unknown) => {
          if (!isIdentifierReference(identifier)) {
            return false;
          }
          if (context.sourceCode.isGlobalReference(identifier)) {
            return true;
          }
          const variable = resolveVariable(context, identifier);
          return variable === null || variable.defs.length === 0;
        };
        const classification = (
          callee: unknown,
          visited = new Set<unknown>(),
        ): "owner" | "raw" | null => {
          const expression = unwrapExpression(callee);
          if (!expression) {
            return null;
          }
          const memberObject =
            expression.type === "MemberExpression"
              ? unwrapExpression(expression.object)
              : null;
          if (
            expression.type === "MemberExpression" &&
            memberPropertyName(expression) === "fetch" &&
            isIdentifierReference(memberObject) &&
            memberObject.name === "globalThis" &&
            isGlobalReference(memberObject)
          ) {
            return "raw";
          }
          if (
            isIdentifierReference(expression) &&
            expression.name === "fetch" &&
            isGlobalReference(expression)
          ) {
            return "raw";
          }
          const imported = resolveImport(context, expression);
          if (imported) {
            if (
              (imported.moduleId === "@stll/fetch" ||
                imported.moduleId === "@stll/fetch/publisher") &&
              OWNER_EXPORTS.has(imported.imported)
            ) {
              return "owner";
            }
            if (
              (imported.moduleId === "@stll/fetch" ||
                imported.moduleId === "undici") &&
              RAW_FETCH_EXPORTS.has(imported.imported)
            ) {
              return "raw";
            }
            if (
              NODE_HTTP_MODULES.has(imported.moduleId) &&
              NODE_HTTP_EXPORTS.has(imported.imported)
            ) {
              return "raw";
            }
          }
          if (!isIdentifierReference(expression)) {
            return null;
          }
          const variable = resolveVariable(context, expression);
          if (!variable || visited.has(variable)) {
            return null;
          }
          const initial = unwrapExpression(stableInitializer(variable));
          if (!initial) {
            return null;
          }
          return classification(initial, new Set([...visited, variable]));
        };
        return {
          CallExpression(node) {
            if (!isAstNode(node.callee)) {
              return;
            }
            if (classification(node.callee) === "raw") {
              context.report({ node, messageId: "rawPublisherRequest" });
            }
          },
        };
      },
    },
  },
});
