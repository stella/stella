// Pagination cursors accepted at an API boundary come from the shared schema
// helper. Several handlers repeated `t.Optional(t.String())`, while sibling
// handlers capped the same opaque cursor shape; the copies therefore accepted
// different input envelopes before reaching the common decoder.
//
// A bounded inline string is no better than an unbounded one: it is a second
// copy of a cap `tPaginationCursor()` already owns, and a literal that agrees
// with the shared value today is the one that silently disagrees tomorrow. So
// every object property named `cursor` (identifier or quoted key) whose value
// is an inline `t.String(...)`, bare or wrapped in `t.Optional(...)`, is
// reported. A provider-owned continuation token passes its own bound through
// `tPaginationCursor({ maxChars })` rather than weakening the shared default.
//
// A file that genuinely accepts something else — an upstream page number with
// its own syntax `pattern` — is named in `allowedFiles` in oxlint.config.ts,
// with the reason next to it.

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import { filenameForContext } from "./utils.ts";

type AstNode = Ranged & { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

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

// The cursor schema itself, with the optional wrapper peeled off.
const cursorSchema = (value: unknown): unknown => {
  if (!isMemberCall(value, "t", "Optional")) {
    return value;
  }
  return isAstNode(value) && Array.isArray(value.arguments)
    ? value.arguments.at(0)
    : value;
};

export default eslintCompatPlugin({
  meta: { name: "require-pagination-cursor-schema" },
  rules: {
    "require-pagination-cursor-schema": {
      meta: {
        type: "problem",
        messages: {
          inlineCursor:
            "Use t.Optional(tPaginationCursor()) for pagination cursors. " +
            "The byte cap and the description belong to the helper in " +
            "apps/api/src/lib/custom-schema.ts; pass tPaginationCursor({ maxChars }) " +
            "when an external continuation token needs a larger bound, or add " +
            "this file to the allowlist in oxlint.config.ts with a reason.",
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
            if (isMemberCall(cursorSchema(node.value), "t", "String")) {
              context.report({ node, messageId: "inlineCursor" });
            }
          },
        };
      },
    },
  },
});
