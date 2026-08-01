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

const TEMPLATE_PREFIX = "/workspaces/";
const TEMPLATE_MIDDLE = "/entities/";
const LEGACY_ENTITY_ROUTE_LITERAL =
  /^\/workspaces\/[^/?#]+\/entities\/[^/?#]+(?:[/?#]|$)/u;
const STATIC_WORKSPACE_ENTITY_PREFIX = /^\/workspaces\/[^/?#]+\/entities\/$/u;
const STATIC_ENTITY_AFTER_WORKSPACE = /^\/entities\/[^/?#]+(?:[/?#]|$)/u;

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

const isLegacyRouteQuasis = (quasis: readonly string[]): boolean => {
  const first = quasis.at(0);
  if (first === undefined) {
    return false;
  }
  if (LEGACY_ENTITY_ROUTE_LITERAL.test(first)) {
    return true;
  }
  const second = quasis.at(1);
  if (second === undefined) {
    return false;
  }
  if (first === TEMPLATE_PREFIX) {
    if (STATIC_ENTITY_AFTER_WORKSPACE.test(second)) {
      return true;
    }
    const third = quasis.at(2);
    return second === TEMPLATE_MIDDLE && third !== undefined;
  }
  return STATIC_WORKSPACE_ENTITY_PREFIX.test(first);
};

const templateQuasis = (template: AstNode): string[] | null => {
  if (!Array.isArray(template.quasis)) {
    return null;
  }
  const quasis: string[] = [];
  for (let index = 0; index < template.quasis.length; index += 1) {
    const text = templateQuasiText(template, index);
    if (text === null) {
      return null;
    }
    quasis.push(text);
  }
  return quasis;
};

type ConcatenationPart = string | null;

const concatenationParts = (node: unknown): ConcatenationPart[] => {
  if (isStringLiteral(node)) {
    return [node.value];
  }
  if (
    !isAstNode(node) ||
    node.type !== "BinaryExpression" ||
    node.operator !== "+"
  ) {
    return [null];
  }
  return concatenationParts(node.left).concat(concatenationParts(node.right));
};

const concatenationQuasis = (node: AstNode): string[] | null => {
  if (node.type !== "BinaryExpression" || node.operator !== "+") {
    return null;
  }
  const quasis = [""];
  for (const part of concatenationParts(node)) {
    if (part === null) {
      quasis.push("");
      continue;
    }
    const index = quasis.length - 1;
    quasis[index] = `${quasis[index]}${part}`;
  }
  return quasis;
};

const hasConcatenationParent = (node: AstNode): boolean =>
  isAstNode(node.parent) &&
  node.parent.type === "BinaryExpression" &&
  node.parent.operator === "+";

const isLegacyEntityRouteConstruction = (node: unknown): boolean => {
  if (isStringLiteral(node)) {
    if (hasConcatenationParent(node)) {
      return false;
    }
    return LEGACY_ENTITY_ROUTE_LITERAL.test(node.value);
  }
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "TemplateLiteral") {
    const quasis = templateQuasis(node);
    return quasis !== null && isLegacyRouteQuasis(quasis);
  }
  if (hasConcatenationParent(node)) {
    return false;
  }
  const quasis = concatenationQuasis(node);
  return quasis !== null && isLegacyRouteQuasis(quasis);
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
          Literal: check,
          TemplateLiteral: check,
        };
      },
    },
  },
};
