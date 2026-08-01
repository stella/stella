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

const LEGACY_ENTITY_ROUTE = "/workspaces/$workspaceId/entities/$entityId";
const TEMPLATE_PREFIX = "/workspaces/";
const TEMPLATE_MIDDLE = "/entities/";

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: "legacyEntityRoute" }) => void;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

const templateQuasiText = (
  template: AstNode,
  index: number,
): string | null => {
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

const isLegacyEntityRouteConstruction = (node: unknown): boolean => {
  if (isStringLiteral(node)) {
    return node.value === LEGACY_ENTITY_ROUTE;
  }
  if (!isAstNode(node) || node.type !== "TemplateLiteral") {
    return false;
  }
  const expressions = node.expressions;
  if (!Array.isArray(expressions)) {
    return false;
  }
  if (expressions.length === 0) {
    return templateQuasiText(node, 0) === LEGACY_ENTITY_ROUTE;
  }
  return (
    expressions.length === 2 &&
    templateQuasiText(node, 0) === TEMPLATE_PREFIX &&
    templateQuasiText(node, 1) === TEMPLATE_MIDDLE &&
    templateQuasiText(node, 2) === ""
  );
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
          Literal: check,
          TemplateLiteral: check,
        };
      },
    },
  },
};
