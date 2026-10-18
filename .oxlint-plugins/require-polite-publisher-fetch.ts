import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RAW_FETCH_EXPORTS = new Set(["fetchWithTimeout", "fetch"]);
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
        const classification = (
          callee: unknown,
          visited = new Set<unknown>(),
        ): "owner" | "raw" | null => {
          const expression = unwrapExpression(callee);
          if (!isIdentifierReference(expression)) {
            return null;
          }
          if (
            expression.name === "fetch" &&
            resolveVariable(context, expression) === null
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
