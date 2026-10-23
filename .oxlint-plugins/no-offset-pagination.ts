import { eslintCompatPlugin } from "@oxlint/plugins";
// Disallow new request-level offset pagination in API handlers.
// Large list endpoints should use cursor pagination and the standard Page<T>
// envelope. Legacy offset endpoints must be listed explicitly in oxlint.config.ts
// with a justification.
//
// An `offset` property is a request field when its value is schema-shaped:
// it contains a valibot call (`v.number()`, `v.optional(...)`), a wire helper
// from `@stll/api-contract/http-input` (`numberFromString(...)`), or a call or
// binding named `...Schema` (`decisionPageOffsetSchema()`). Any wrapper around
// it is seen through, so `v.exactOptional(numberFromString(...))` cannot hide
// the offset. A runtime value (`offset: 20`, `offset: page * size`) is not a
// schema and stays out of scope.

import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  isFileIn,
  unwrapExpression,
} from "./utils.ts";

const WIRE_HELPERS: ReadonlySet<string> = new Set([
  "arrayFromQuery",
  "booleanFromString",
  "jsonFromString",
  "numberFromString",
]);

const SCHEMA_NAME = /Schema$/u;

const isSchemaCallee = (calleeName: string): boolean =>
  calleeName.startsWith("v.") ||
  WIRE_HELPERS.has(calleeName) ||
  SCHEMA_NAME.test(calleeName);

const containsRequestSchema = (node: unknown): boolean => {
  const current = unwrapExpression(node);
  if (current === null) {
    return false;
  }
  if (current.type === "Identifier") {
    return typeof current.name === "string" && SCHEMA_NAME.test(current.name);
  }
  if (current.type !== "CallExpression") {
    return false;
  }
  const calleeName = getCalleeName(current.callee);
  if (calleeName !== null && isSchemaCallee(calleeName)) {
    return true;
  }
  const args = Array.isArray(current.arguments) ? current.arguments : [];
  return args.some(
    (argument) =>
      isAstNode(argument) &&
      argument.type !== "SpreadElement" &&
      containsRequestSchema(argument),
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-offset-pagination" },
  rules: {
    "no-offset-pagination": {
      meta: {
        type: "problem",
        messages: {
          noOffsetPagination:
            "New API list endpoints must use cursor pagination: accept " +
            "`cursor: v.optional(paginationCursorSchema())` and " +
            "`limit: v.optional(numberFromString(paginationLimitSchema(max)))` " +
            "and return Page<T>. Offset pagination requires an explicit " +
            "`allowedFiles` exception with its reason in oxlint.config.ts.",
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
            return !isFileIn(context, allowedFiles);
          },
          Property(node) {
            if (getPropertyName(node.key) !== "offset") {
              return;
            }

            if (!containsRequestSchema(node.value)) {
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
