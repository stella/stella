// Pagination cursors accepted at an API boundary must use the shared bounded
// schema. Several handlers repeated `t.Optional(t.String())`, while sibling
// handlers capped the same opaque cursor shape; the copies therefore accepted
// different input envelopes before reaching the common decoder.
//
// The ban is deliberately scoped to object properties literally named
// `cursor` whose value is the exact unbounded `t.Optional(t.String(...))`
// shape. Bounded inline strings remain valid, as do non-pagination optional
// strings. Provider-owned continuation tokens can call
// `tPaginationCursor(customMaximum)` instead of weakening the shared default.
// The `unbounded-pagination-cursor-schema` ratchet metric covers whitespace and
// alias variants the exact call-shape AST rule cannot identify.

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: "unboundedCursor" }) => void;
};

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

const hasMaxLength = (call: AstNode): boolean => {
  if (!Array.isArray(call.arguments)) {
    return false;
  }
  const options = call.arguments.at(0);
  if (!isAstNode(options) || options.type !== "ObjectExpression") {
    return false;
  }
  return (
    Array.isArray(options.properties) &&
    options.properties.some(
      (property) =>
        isAstNode(property) &&
        property.type === "Property" &&
        getStaticName(property.key) === "maxLength",
    )
  );
};

export default {
  meta: { name: "require-pagination-cursor-schema" },
  rules: {
    "require-pagination-cursor-schema": {
      meta: {
        type: "problem",
        messages: {
          unboundedCursor:
            "Use t.Optional(tPaginationCursor()) for pagination cursors. " +
            "Pass a custom maximum to tPaginationCursor(...) when an " +
            "external continuation token needs a larger bound.",
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
            ".oxlint-plugins/__fixtures__/require-pagination-cursor-schema.fixture.ts",
          )
        ) {
          return {};
        }
        return {
          Property(node: AstNode) {
            if (getStaticName(node.key) !== "cursor") {
              return;
            }
            const optionalCall = node.value;
            if (!isMemberCall(optionalCall, "t", "Optional")) {
              return;
            }
            if (
              !isAstNode(optionalCall) ||
              !Array.isArray(optionalCall.arguments)
            ) {
              return;
            }
            const stringCall = optionalCall.arguments.at(0);
            if (
              isAstNode(stringCall) &&
              isMemberCall(stringCall, "t", "String") &&
              !hasMaxLength(stringCall)
            ) {
              context.report({ node, messageId: "unboundedCursor" });
            }
          },
        };
      },
    },
  },
};
