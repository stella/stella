// A user avatar and its visible name must render through UserIdentity. Several
// surfaces placed `<UserAvatar name={X}>` beside a separate `{X}` label; those
// labels bypassed the shared display-name fallback, bidirectional isolation,
// and deleted-account styling even though the avatar looked correct.
//
// The ban is deliberately scoped to a UserAvatar with a sibling that renders
// the exact same identifier or member expression. Avatar-only controls,
// transformed short labels, combined metadata, and different nearby text are
// legitimate variants. The `hand-rolled-user-identity` ratchet metric covers
// expressions and nesting shapes this exact AST comparison cannot recognize.

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: "useIdentity" }) => void;
};

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const getJsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return getJsxName(node.property);
  }
  return null;
};

const getAttributeName = (attribute: unknown): string | null => {
  if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
    return null;
  }
  return getJsxName(attribute.name);
};

const expressionKey = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type !== "MemberExpression" || node.computed === true) {
    return null;
  }
  const object = expressionKey(node.object);
  const property = expressionKey(node.property);
  return object === null || property === null ? null : `${object}.${property}`;
};

const userAvatarNameKey = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return null;
  }
  const opening = node.openingElement;
  if (
    !isAstNode(opening) ||
    getJsxName(opening.name) !== "UserAvatar" ||
    !Array.isArray(opening.attributes)
  ) {
    return null;
  }
  const nameAttribute = opening.attributes.find(
    (attribute) => getAttributeName(attribute) === "name",
  );
  if (!isAstNode(nameAttribute) || !isAstNode(nameAttribute.value)) {
    return null;
  }
  const value = nameAttribute.value;
  return value.type === "JSXExpressionContainer"
    ? expressionKey(value.expression)
    : null;
};

const containsRenderedExpression = (node: unknown, key: string): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "JSXExpressionContainer" &&
    expressionKey(node.expression) === key
  ) {
    return true;
  }
  if (!Array.isArray(node.children)) {
    return false;
  }
  return node.children.some((child) => containsRenderedExpression(child, key));
};

export default {
  meta: { name: "no-hand-rolled-user-identity" },
  rules: {
    "no-hand-rolled-user-identity": {
      meta: {
        type: "problem",
        messages: {
          useIdentity:
            "Render UserIdentity instead of placing UserAvatar beside the " +
            "same user name.",
        },
      },
      create(context: RuleContext) {
        const filename = (
          context.filename ??
          context.getFilename?.() ??
          ""
        ).replaceAll("\\", "/");
        if (
          !filename.includes("apps/web/src/") &&
          !filename.endsWith(
            ".oxlint-plugins/__fixtures__/no-hand-rolled-user-identity.fixture.tsx",
          )
        ) {
          return {};
        }
        return {
          JSXElement(node: AstNode) {
            if (!Array.isArray(node.children)) {
              return;
            }
            for (const child of node.children) {
              const key = userAvatarNameKey(child);
              if (
                key !== null &&
                node.children.some(
                  (sibling) =>
                    sibling !== child &&
                    containsRenderedExpression(sibling, key),
                )
              ) {
                context.report({ node: child, messageId: "useIdentity" });
              }
            }
          },
        };
      },
    },
  },
};
