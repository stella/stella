// A two-column `(timestamp, id)` keyset predicate must be built by
// createTimestampIdCursorCodec.keysetAfter. Several handlers called
// pgTimestampCursorBoundary in both branches of a hand-written disjunction;
// those copies omitted precision-dependent behavior owned by the codec.
//
// The ban is deliberately scoped to `or(...)` expressions containing the
// boundary helper more than once. A single boundary call is ordinary range
// logic, and heterogeneous three-part cursors cannot use the two-column
// codec. The `repeated-timestamp-cursor-boundary` ratchet metric covers
// equivalent predicate spellings outside the exact imported-binding shape.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const DB_PAGINATION_MODULE = "@/api/lib/db-pagination";
const DRIZZLE_MODULE = "drizzle-orm";

const countBoundaryCalls = (
  node: unknown,
  boundaryBindings: ReadonlySet<string>,
): number => {
  if (!isAstNode(node)) {
    return 0;
  }
  let count =
    node.type === "CallExpression" &&
    isIdentifier(node.callee) &&
    boundaryBindings.has(node.callee.name)
      ? 1
      : 0;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        count += countBoundaryCalls(child, boundaryBindings);
      }
    } else {
      count += countBoundaryCalls(value, boundaryBindings);
    }
  }
  return count;
};

export default eslintCompatPlugin({
  meta: { name: "require-timestamp-id-cursor-codec" },
  rules: {
    "require-timestamp-id-cursor-codec": {
      meta: {
        type: "problem",
        messages: {
          useCodec:
            "Use createTimestampIdCursorCodec(...).keysetAfter(...) for a " +
            "(timestamp, id) keyset predicate.",
        },
      },
      createOnce(context) {
        const boundaryBindings = new Set(["pgTimestampCursorBoundary"]);
        const orBindings = new Set(["or"]);
        return {
          before() {
            boundaryBindings.clear();
            boundaryBindings.add("pgTimestampCursorBoundary");
            orBindings.clear();
            orBindings.add("or");
            const filename = filenameForContext(context);
            return (
              filename.includes("apps/api/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/require-timestamp-id-cursor-codec.fixture.ts",
              )
            );
          },
          ImportDeclaration(node) {
            const source = node.source;
            if (!isStringLiteral(source) || !Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const importedName = getImportedName(specifier);
              const localName = getImportLocalName(specifier);
              if (
                source.value === DB_PAGINATION_MODULE &&
                importedName === "pgTimestampCursorBoundary" &&
                localName !== null
              ) {
                boundaryBindings.add(localName);
              }
              if (
                source.value === DRIZZLE_MODULE &&
                importedName === "or" &&
                localName !== null
              ) {
                orBindings.add(localName);
              }
            }
          },
          CallExpression(node) {
            if (
              isIdentifier(node.callee) &&
              orBindings.has(node.callee.name) &&
              countBoundaryCalls(node, boundaryBindings) > 1
            ) {
              context.report({ node, messageId: "useCodec" });
            }
          },
        };
      },
    },
  },
});
