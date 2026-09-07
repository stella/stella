import { eslintCompatPlugin } from "@oxlint/plugins";

import { type AstNode, isAstNode, isIdentifier } from "./utils.ts";

// Base UI positions and collision-tests the Positioner, not the Popup, so the
// positioner must measure the popup on both axes. Two sizing strategies each
// fail in one direction:
//   - `w-(--positioner-width)`: Base UI writes the variable only when the popup
//     payload changes, so content that grows from local state while open
//     outgrows the positioner and escapes collision handling.
//   - `w-max`: a `Viewport` writes `position: absolute` inline on the popup for
//     `side="top"` and `side="left"` to anchor size transitions, and an
//     out-of-flow popup contributes nothing to `max-content`, so the positioner
//     collapses to 0px and the popup paints past the viewport edge.
// `packages/ui/src/lib/positioner-sizing.ts` owns the pair that satisfies both
// (a content-sized positioner around a popup forced back into flow). This rule
// makes every Viewport-bearing positioner use it.
//
// Flagged (only when the Positioner subtree renders a `*.Viewport`):
//   - `<X.Positioner>` whose `className` does not reference
//     `CONTENT_SIZED_POSITIONER_CLASS_NAME`.
//   - `<X.Popup>` inside it whose `className` does not reference
//     `IN_FLOW_POPUP_CLASS_NAME`.
// Allowed: positioners without a Viewport; nothing takes their popup out of
// flow, so the positioner shrink-wraps it on its own.

const POSITIONER_CLASS_CONSTANT = "CONTENT_SIZED_POSITIONER_CLASS_NAME";
const POPUP_CLASS_CONSTANT = "IN_FLOW_POPUP_CLASS_NAME";

const memberElementRole = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return null;
  }
  const opening = node.openingElement;
  if (!isAstNode(opening)) {
    return null;
  }
  const name = opening.name;
  if (!isAstNode(name) || name.type !== "JSXMemberExpression") {
    return null;
  }
  const property = name.property;
  return isAstNode(property) && typeof property.name === "string"
    ? property.name
    : null;
};

const jsxDescendants = (node: AstNode): AstNode[] => {
  const found: AstNode[] = [];
  const children = node.children;
  if (!Array.isArray(children)) {
    return found;
  }
  for (const child of children) {
    if (!isAstNode(child)) {
      continue;
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      found.push(child, ...jsxDescendants(child));
    }
  }
  return found;
};

// Whether an expression references the identifier anywhere inside it, so the
// constant may sit in a `cn(...)` call, a template literal, or a conditional.
const referencesIdentifier = (node: unknown, name: string): boolean => {
  if (isIdentifier(node, name)) {
    return true;
  }
  if (typeof node !== "object" || node === null) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => referencesIdentifier(item, name))) {
        return true;
      }
    } else if (isAstNode(value) && referencesIdentifier(value, name)) {
      return true;
    }
  }
  return false;
};

const classNameReferences = (element: AstNode, name: string): boolean => {
  const opening = element.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return false;
  }
  const classNameAttribute = opening.attributes.find(
    (attribute) =>
      isAstNode(attribute) &&
      attribute.type === "JSXAttribute" &&
      isAstNode(attribute.name) &&
      attribute.name.name === "className",
  );
  if (!isAstNode(classNameAttribute)) {
    return false;
  }
  const value = classNameAttribute.value;
  if (!isAstNode(value) || value.type !== "JSXExpressionContainer") {
    return false;
  }
  return referencesIdentifier(value.expression, name);
};

export default eslintCompatPlugin({
  meta: { name: "require-in-flow-viewport-popup" },
  rules: {
    "require-in-flow-viewport-popup": {
      meta: {
        type: "problem",
        messages: {
          positionerSizing:
            "A positioner that renders a Viewport must size to its popup: " +
            "include `CONTENT_SIZED_POSITIONER_CLASS_NAME` from " +
            "`packages/ui/src/lib/positioner-sizing.ts` in its className. " +
            "Base UI collision-tests the positioner, and neither " +
            "`--positioner-width` (stale after local-state growth) nor a bare " +
            "`w-max` (0px around the out-of-flow popup a Viewport creates for " +
            "side top/left) measures the popup on every side.",
          popupInFlow:
            "A popup under a Viewport must stay in normal flow: include " +
            "`IN_FLOW_POPUP_CLASS_NAME` from " +
            "`packages/ui/src/lib/positioner-sizing.ts` in its className. " +
            "Base UI writes `position: absolute` inline on it for side " +
            "top/left, which collapses the content-sized positioner to 0px.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node) {
            if (!isAstNode(node) || memberElementRole(node) !== "Positioner") {
              return;
            }
            const descendants = jsxDescendants(node);
            if (
              !descendants.some(
                (descendant) => memberElementRole(descendant) === "Viewport",
              )
            ) {
              return;
            }
            const opening = node.openingElement;
            if (
              isAstNode(opening) &&
              !classNameReferences(node, POSITIONER_CLASS_CONSTANT)
            ) {
              context.report({ node: opening, messageId: "positionerSizing" });
            }
            for (const descendant of descendants) {
              const popupOpening = descendant.openingElement;
              if (
                memberElementRole(descendant) === "Popup" &&
                isAstNode(popupOpening) &&
                !classNameReferences(descendant, POPUP_CLASS_CONSTANT)
              ) {
                context.report({
                  node: popupOpening,
                  messageId: "popupInFlow",
                });
              }
            }
          },
        };
      },
    },
  },
});
