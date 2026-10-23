// Pagination cursors accepted at an API boundary come from the shared schema
// helper. Several handlers repeated an optional inline string, while sibling
// handlers capped the same opaque cursor shape; the copies therefore accepted
// different input envelopes before reaching the common decoder.
//
// A bounded inline string is no better than an unbounded one: it is a second
// copy of a cap `paginationCursorSchema()` already owns, and a literal that
// agrees with the shared value today is the one that silently disagrees
// tomorrow. So every object property named `cursor` (identifier or quoted key)
// whose schema is an inline `v.string()` is reported: bare, under any of the
// optional/nullable wrappers, or at the head of a `v.pipe(...)` whatever steps
// follow it. A provider-owned continuation token gives its own bound to
// `paginationCursorSchema({ maxChars })` rather than weakening the shared
// default, and a cursor that needs a decode check pipes the helper:
// `v.pipe(paginationCursorSchema(), v.check(...))`.
//
// A file that genuinely accepts something else — an upstream page number with
// its own syntax `v.regex` — is named in `allowedFiles` in oxlint.config.ts,
// with the reason next to it.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode, unwrapExpression } from "./utils.ts";

const getStaticName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
};

const isMemberCall = (node: unknown, object: string, property: string) => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return false;
  }
  return (
    getStaticName(callee.object) === object &&
    getStaticName(callee.property) === property
  );
};

const configuredAllowedFiles = (context: {
  options?: readonly unknown[];
}): readonly string[] => {
  const options = context.options?.[0];
  if (typeof options !== "object" || options === null) {
    return [];
  }
  const allowedFiles = Reflect.get(options, "allowedFiles");
  return Array.isArray(allowedFiles)
    ? allowedFiles.filter((entry) => typeof entry === "string")
    : [];
};

// Wrappers whose first argument is the schema that reads the cursor.
const CURSOR_WRAPPERS = [
  "exactOptional",
  "nullable",
  "nullish",
  "optional",
  "pipe",
  "undefinedable",
] as const;

// Whether the cursor schema, with its wrappers peeled off, is an inline
// `v.string()`.
const isInlineStringCursor = (value: unknown): boolean => {
  let schema = unwrapExpression(value);
  while (schema !== null) {
    if (isMemberCall(schema, "v", "string")) {
      return true;
    }
    const current = schema;
    if (!CURSOR_WRAPPERS.some((name) => isMemberCall(current, "v", name))) {
      return false;
    }
    schema = Array.isArray(current.arguments)
      ? unwrapExpression(current.arguments.at(0))
      : null;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "require-pagination-cursor-schema" },
  rules: {
    "require-pagination-cursor-schema": {
      meta: {
        type: "problem",
        messages: {
          inlineCursor:
            "Use v.optional(paginationCursorSchema()) for pagination cursors. " +
            "The length cap and the description belong to the helper in " +
            "apps/api/src/lib/custom-schema.ts. Give an external continuation " +
            "token its bound with paginationCursorSchema({ maxChars }), pipe " +
            "the helper into v.check(...) to validate the decoded cursor, or " +
            "add this file to the allowlist in oxlint.config.ts with a reason.",
        },
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            if (
              configuredAllowedFiles(context).some((allowed) =>
                filename.endsWith(allowed),
              )
            ) {
              return false;
            }
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/require-pagination-cursor-schema.fixture.ts",
              )
            );
          },
          Property(node) {
            if (getStaticName(node.key) !== "cursor") {
              return;
            }
            if (isInlineStringCursor(node.value)) {
              context.report({ node, messageId: "inlineCursor" });
            }
          },
        };
      },
    },
  },
});
