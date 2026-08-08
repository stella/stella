// A two-column `(timestamp, id)` keyset predicate must be built by
// createTimestampIdCursorCodec.keysetAfter. Several handlers called
// pgTimestampCursorBoundary in both branches of a hand-written disjunction;
// those copies omitted precision-dependent behavior owned by the codec.
//
// The ban is deliberately scoped to `or(...)` expressions containing the
// boundary helper more than once. A single boundary call is ordinary range
// logic, and heterogeneous three-part cursors cannot use the two-column
// codec. The `repeated-timestamp-cursor-boundary` ratchet metric covers
// aliases and equivalent spellings this name-based AST rule cannot resolve.

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: "useCodec" }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const isIdentifierNamed = (node: unknown, name: string): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === name;

const countBoundaryCalls = (node: unknown): number => {
  if (!isAstNode(node)) {
    return 0;
  }
  let count =
    node.type === "CallExpression" &&
    isIdentifierNamed(node.callee, "pgTimestampCursorBoundary")
      ? 1
      : 0;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        count += countBoundaryCalls(child);
      }
    } else {
      count += countBoundaryCalls(value);
    }
  }
  return count;
};

export default {
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
      create(context: RuleContext) {
        const filename = (
          context.filename ??
          context.getFilename?.() ??
          ""
        ).replaceAll("\\", "/");
        if (
          !filename.includes("apps/api/src/") &&
          !filename.endsWith(
            ".oxlint-plugins/__fixtures__/require-timestamp-id-cursor-codec.fixture.ts",
          )
        ) {
          return {};
        }
        return {
          CallExpression(node: AstNode) {
            if (
              isIdentifierNamed(node.callee, "or") &&
              countBoundaryCalls(node) > 1
            ) {
              context.report({ node, messageId: "useCodec" });
            }
          },
        };
      },
    },
  },
};
