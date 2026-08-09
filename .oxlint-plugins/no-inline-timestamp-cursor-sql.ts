import { eslintCompatPlugin } from "@oxlint/plugins";
// Timestamp cursor SQL must come from db-pagination's projection and boundary
// helpers. Several list implementations repeated the PostgreSQL format
// without the canonical UTC marker and rebuilt the re-anchor expression at
// their comparison sites, allowing encode and decode behavior to diverge.
//
// The ban is deliberately limited to the exact cursor format and UTC
// re-anchor spellings. Other to_char formats are ordinary presentation or
// faceting logic. `case-law/citation-authority.ts` is explicitly spared: its
// re-anchor converts a date for elapsed-time arithmetic, not a cursor.
// The `inline-timestamp-cursor-sql` ratchet metric covers textual cursor SQL
// variants the literal-based AST rule cannot identify.

import { filenameForContext, isAstNode } from "./utils.ts";

const LEGACY_CURSOR_FORMAT = /YYYY-MM-DD"T"HH24:MI:SS\.US(?!"Z")/u;
const INLINE_UTC_BOUNDARY = /::\s*timestamp\s+AT\s+TIME\s+ZONE\s*['"]UTC['"]/iu;

const ALLOWED_FILES = [
  "apps/api/src/lib/db-pagination.ts",
  "apps/api/src/handlers/case-law/citation-authority.ts",
  ".oxlint-plugins/__fixtures__/no-naive-timestamp-cast.fixture.ts",
  ".oxlint-plugins/__fixtures__/no-truncated-timestamp-comparison.fixture.ts",
];

const textForLiteralNode = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if ("cooked" in value && typeof value.cooked === "string") {
    return value.cooked;
  }
  if ("raw" in value && typeof value.raw === "string") {
    return value.raw;
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-inline-timestamp-cursor-sql" },
  rules: {
    "no-inline-timestamp-cursor-sql": {
      meta: {
        type: "problem",
        messages: {
          legacyFormat:
            "Use pgTimestampCursorValue(...) instead of spelling the " +
            "timestamp cursor format inline.",
          inlineBoundary:
            "Use pgTimestampCursorBoundary(...) instead of spelling the " +
            "timestamp cursor boundary inline.",
        },
      },
      createOnce(context) {
        const messageIdsFor = (node: unknown) => {
          const value = textForLiteralNode(node);
          if (value === null) {
            return [];
          }
          const messageIds: ("inlineBoundary" | "legacyFormat")[] = [];
          if (LEGACY_CURSOR_FORMAT.test(value)) {
            messageIds.push("legacyFormat");
          }
          if (INLINE_UTC_BOUNDARY.test(value)) {
            messageIds.push("inlineBoundary");
          }
          return messageIds;
        };
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/api/src/") ||
                filename.endsWith(
                  ".oxlint-plugins/__fixtures__/no-inline-timestamp-cursor-sql.fixture.ts",
                )) &&
              !ALLOWED_FILES.some((allowed) => filename.endsWith(allowed))
            );
          },
          Literal(node) {
            for (const messageId of messageIdsFor(node)) {
              context.report({ node, messageId });
            }
          },
          TemplateElement(node) {
            for (const messageId of messageIdsFor(node)) {
              context.report({ node, messageId });
            }
          },
        };
      },
    },
  },
});
