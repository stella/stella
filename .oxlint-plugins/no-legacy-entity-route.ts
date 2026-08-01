// Prevent new internal navigation through the legacy entity detail route.
//
// The public `/workspaces/$workspaceId/entities/$entityId` route was removed.
// Callers must use a canonical workspace or document destination instead.
//
// Flagged:
//   to: "/workspaces/$workspaceId/entities/$entityId"
//   const legacy = `/workspaces/${workspaceId}/entities/${entityId}`;
//
// Allowed:
//   to: "/workspaces/$workspaceId/$viewId/document"
//   `/entities/${workspaceId}/entity/${entityId}` // API path, not web route

import { isStringLiteral } from "./utils.ts";

const DYNAMIC_PART = "\u{E000}";
const LEGACY_ENTITY_ROUTE =
  /^\/workspaces\/(?:[^/?#\u{E000}]|\u{E000})+\/entities\/(?:[^/?#\u{E000}]|\u{E000})+(?=[/?#]|$)/u;

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: {
    node: unknown;
    messageId: "legacyEntityRoute";
  }) => void;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

const templateQuasiText = (template: AstNode, index: number): string | null => {
  const quasis = template.quasis;
  if (!Array.isArray(quasis)) {
    return null;
  }
  const quasi = quasis[index];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null || !("cooked" in value)) {
    return null;
  }
  const cooked = Object.getOwnPropertyDescriptor(value, "cooked")?.value;
  return typeof cooked === "string" ? cooked : null;
};

type RoutePart = string | null;

const isConcatCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression" || !isAstNode(node.callee)) {
    return false;
  }
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || !isAstNode(callee.property)) {
    return false;
  }
  if (callee.computed === true) {
    return (
      isStringLiteral(callee.property) && callee.property.value === "concat"
    );
  }
  return (
    callee.property.type === "Identifier" && callee.property.name === "concat"
  );
};

const routeParts = (node: unknown): RoutePart[] => {
  if (isStringLiteral(node)) {
    return [node.value];
  }
  if (!isAstNode(node)) {
    return [null];
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return routeParts(node.left).concat(routeParts(node.right));
  }
  if (isConcatCall(node) && isAstNode(node.callee)) {
    const callee = node.callee;
    if (!isAstNode(callee.object) || !Array.isArray(node.arguments)) {
      return [null];
    }
    return [callee.object, ...node.arguments].flatMap(routeParts);
  }
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) {
    return [null];
  }

  const expressions = node.expressions;
  if (!Array.isArray(expressions)) {
    return [null];
  }
  const parts: RoutePart[] = [];
  for (let index = 0; index < node.quasis.length; index += 1) {
    const text = templateQuasiText(node, index);
    if (text === null) {
      return [null];
    }
    parts.push(text);
    const expression = expressions[index];
    if (expression !== undefined) {
      parts.push(...routeParts(expression));
    }
  }
  return parts;
};

const hasRouteConstructionParent = (node: AstNode): boolean => {
  if (!isAstNode(node.parent)) {
    return false;
  }
  const parent = node.parent;
  if (parent.type === "BinaryExpression" && parent.operator === "+") {
    return true;
  }
  if (parent.type !== "MemberExpression" || parent.object !== node) {
    return false;
  }
  return isAstNode(parent.parent) && isConcatCall(parent.parent);
};

const isLegacyEntityRouteConstruction = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (hasRouteConstructionParent(node)) {
    return false;
  }
  return LEGACY_ENTITY_ROUTE.test(routeParts(node).join(DYNAMIC_PART));
};

export default {
  meta: { name: "no-legacy-entity-route" },
  rules: {
    "no-legacy-entity-route": {
      meta: {
        type: "problem",
        messages: {
          legacyEntityRoute:
            "The legacy entity detail route does not exist. Use a canonical " +
            "workspace or document destination.",
        },
      },
      create(context: RuleContext) {
        const check = (node: unknown) => {
          if (isLegacyEntityRouteConstruction(node)) {
            context.report({ node, messageId: "legacyEntityRoute" });
          }
        };

        return {
          BinaryExpression: check,
          CallExpression: check,
          Literal: check,
          TemplateLiteral: check,
        };
      },
    },
  },
};
