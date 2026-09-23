import { eslintCompatPlugin } from "@oxlint/plugins";
// Disallow new request-level offset pagination in API handlers.
// Large list endpoints should use cursor pagination and the standard Page<T>
// envelope. Legacy offset endpoints must be listed explicitly in oxlint.config.ts
// with a justification.

import { getCalleeName, getPropertyName, isFileIn } from "./utils.ts";

const SCHEMA_CALLEES = new Set([
  "t.Integer",
  "t.Number",
  "t.Optional",
  "t.Union",
]);

const HARDCODED_ALLOWED_FILES = ["apps/api/src/handlers/skills/list.ts"];

const containsRequestSchemaCall = (node) => {
  if (!node) {
    return false;
  }

  if (node.type === "CallExpression") {
    const calleeName = getCalleeName(node.callee);
    if (calleeName !== null && SCHEMA_CALLEES.has(calleeName)) {
      return true;
    }
    return node.arguments.some(containsRequestSchemaCall);
  }

  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return containsRequestSchemaCall(node.expression);
  }

  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-offset-pagination" },
  rules: {
    "no-offset-pagination": {
      meta: {
        type: "problem",
        messages: {
          noOffsetPagination:
            "New API list endpoints must use cursor pagination (`cursor` + `limit`) and return Page<T>. Offset pagination requires an explicit exception in oxlint.config.ts.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        return {
          before() {
            const options = context.options.at(0);
            const allowedFiles =
              typeof options === "object" &&
              options !== null &&
              !Array.isArray(options) &&
              Array.isArray(options.allowedFiles)
                ? options.allowedFiles.filter(
                    (value) => typeof value === "string",
                  )
                : [];
            return !isFileIn(context, [
              ...HARDCODED_ALLOWED_FILES,
              ...allowedFiles,
            ]);
          },
          Property(node) {
            if (getPropertyName(node.key) !== "offset") {
              return;
            }

            if (!containsRequestSchemaCall(node.value)) {
              return;
            }

            context.report({
              node,
              messageId: "noOffsetPagination",
            });
          },
        };
      },
    },
  },
});
