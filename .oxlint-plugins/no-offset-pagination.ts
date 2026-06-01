// Disallow new request-level offset pagination in API handlers.
// Large list endpoints should use cursor pagination and the standard Page<T>
// envelope. Legacy offset endpoints must be listed explicitly in oxlint.config.ts
// with a justification.

import { getCalleeName, getPropertyName } from "./utils.ts";

const SCHEMA_CALLEES = new Set([
  "t.Integer",
  "t.Number",
  "t.Optional",
  "t.Union",
]);

const filenameForContext = (context) =>
  context.filename ?? context.getFilename?.() ?? "";

const isAllowedFile = (context, allowedFiles) => {
  const filename = filenameForContext(context);
  return allowedFiles.some((allowedFile) => filename.endsWith(allowedFile));
};

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

export default {
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
      create(context) {
        const options = context.options?.[0] ?? {};
        const allowedFiles = Array.isArray(options.allowedFiles)
          ? options.allowedFiles
          : [];

        if (isAllowedFile(context, allowedFiles)) {
          return {};
        }

        return {
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
};
