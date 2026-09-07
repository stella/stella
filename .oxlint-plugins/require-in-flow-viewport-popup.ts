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
// Flagged (only when the Positioner subtree renders a `*.Viewport`, whether as
// a direct child or from inside an expression container):
//   - `<X.Positioner>` whose `className` does not carry
//     `CONTENT_SIZED_POSITIONER_CLASS_NAME` on every branch.
//   - `<X.Popup>` inside it whose `className` does not carry
//     `IN_FLOW_POPUP_CLASS_NAME` on every branch.
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

// Elements rendered inside a subtree, including the ones an expression
// container holds: `{open && <X.Viewport />}` and `{items.map(…)}` render as
// surely as a bare child, so a walk that only follows `JSXElement` children
// misses them and reads the positioner as Viewport-free. Attributes are not
// part of the subtree: an element passed as a prop is rendered by whoever
// receives it, under its own positioner.
const collectJsxElements = (value: unknown, found: AstNode[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsxElements(item, found);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  if (value.type === "JSXElement") {
    found.push(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "parent" ||
      key === "openingElement" ||
      key === "closingElement"
    ) {
      continue;
    }
    collectJsxElements(child, found);
  }
};

const jsxDescendants = (node: AstNode): AstNode[] => {
  const found: AstNode[] = [];
  collectJsxElements(node.children, found);
  return found;
};

// Whether every runtime value of an expression carries the identifier, so the
// constant may sit in a `cn(...)` argument, a template literal, or a
// concatenation, but not in a single arm of a conditional or behind a
// short-circuit: a class the popup carries only sometimes leaves the other
// branch with the collapsed positioner this rule exists to prevent.
const alwaysReferencesIdentifier = (node: unknown, name: string): boolean => {
  if (isIdentifier(node, name)) {
    return true;
  }
  if (!isAstNode(node)) {
    return false;
  }
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return alwaysReferencesIdentifier(node.expression, name);
    case "CallExpression":
      return (
        Array.isArray(node.arguments) &&
        node.arguments.some((argument) =>
          alwaysReferencesIdentifier(
            isAstNode(argument) && argument.type === "SpreadElement"
              ? argument.argument
              : argument,
            name,
          ),
        )
      );
    case "ArrayExpression":
      return (
        Array.isArray(node.elements) &&
        node.elements.some((element) =>
          alwaysReferencesIdentifier(element, name),
        )
      );
    case "TemplateLiteral":
      return (
        Array.isArray(node.expressions) &&
        node.expressions.some((expression) =>
          alwaysReferencesIdentifier(expression, name),
        )
      );
    case "BinaryExpression":
      return (
        node.operator === "+" &&
        (alwaysReferencesIdentifier(node.left, name) ||
          alwaysReferencesIdentifier(node.right, name))
      );
    case "ConditionalExpression":
      return (
        alwaysReferencesIdentifier(node.consequent, name) &&
        alwaysReferencesIdentifier(node.alternate, name)
      );
    default:
      return false;
  }
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
  return alwaysReferencesIdentifier(value.expression, name);
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
            "carry `CONTENT_SIZED_POSITIONER_CLASS_NAME` from " +
            "`packages/ui/src/lib/positioner-sizing.ts` on every branch of " +
            "its className. " +
            "Base UI collision-tests the positioner, and neither " +
            "`--positioner-width` (stale after local-state growth) nor a bare " +
            "`w-max` (0px around the out-of-flow popup a Viewport creates for " +
            "side top/left) measures the popup on every side.",
          popupInFlow:
            "A popup under a Viewport must stay in normal flow: carry " +
            "`IN_FLOW_POPUP_CLASS_NAME` from " +
            "`packages/ui/src/lib/positioner-sizing.ts` on every branch of " +
            "its className. " +
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
