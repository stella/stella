// A control hidden with `opacity-0` (or `invisible`) and revealed by a hover
// variant never appears on a touch screen. Tailwind's `hover:` family only
// matches under `@media (hover: hover)`, so on a phone the row action, the
// remove button or the drag handle stays transparent: tappable if the user
// guesses where it is, invisible otherwise.
//
// Invariant: a class string that hides something until hover also says what
// happens on a coarse pointer, with a visibility utility under
// `pointer-coarse:`. Usually that is
// `pointer-coarse:opacity-100`, so touch devices show the control at rest.
//
// Rejected: `opacity-0 group-hover:opacity-100`,
// `opacity-0! group-hover/row:opacity-100!`, `invisible hover:visible`.
//
// Accepted:
//   a matching touch reveal or an explicit touch hide under `pointer-coarse:`.
//   a reveal that is not a hover (`focus-visible:opacity-100`,
//   `data-[state=open]:opacity-100`) with no hover reveal beside it.
//   a hover reveal next to one through a state a tap can set
//   (`group-data-[active=true]/card:opacity-100`, `has-[[aria-expanded=true]]:`):
//   a finger has its own way in. A focus reveal does not count; it serves
//   the keyboard.
//
//   decoration, which nobody needs to reach: a string written on an
//   `aria-hidden` element or an `…Icon` component, and an overlay that stays
//   `pointer-events-none` (no `pointer-events-auto` reveal).
//
// Analysis boundary: this reads class strings, not the DOM. Decoration is
// recognised only where the string sits on the element's own `className`; a
// class string held in a constant is judged as a control.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  classTokens,
  classVariants,
  isAstNode,
  jsxName,
} from "./utils.ts";

const HIDDEN = new Set(["opacity-0", "opacity-0!", "invisible", "invisible!"]);
const SHOWN = new Set(["opacity-100", "opacity-100!", "visible", "visible!"]);

const isHoverVariant = (variant: string): boolean =>
  variant === "hover" ||
  variant.startsWith("group-hover") ||
  variant.startsWith("peer-hover");

// A state a tap can set (an open menu, the active card) is a way in that
// does not need hover.
const isTappableStateVariant = (variant: string): boolean =>
  /^(?:group-|peer-)?(?:data|aria|has)-/u.test(variant);

const isCoarsePointerVariant = (variant: string): boolean =>
  variant === "pointer-coarse" || variant === "any-pointer-coarse";

const variantsOf = (token: string): string[] => {
  const variants = classVariants(token);
  return variants === "" ? [] : variants.split(":");
};

const dependsOnHover = (token: string): boolean =>
  variantsOf(token).some(isHoverVariant) ||
  /:hover\b/u.test(classVariants(token));

// The opening element whose attribute holds this string, through any `cn()`
// call or expression container between them.
const owningAttribute = (node: unknown): Record<string, unknown> | null => {
  let current: unknown = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (current.type === "JSXAttribute") {
      return current;
    }
    if (
      current.type === "JSXElement" ||
      current.type === "VariableDeclarator" ||
      current.type === "Program"
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
};

const isHiddenFromAssistiveTech = (attribute: unknown): boolean => {
  if (
    !isAstNode(attribute) ||
    attribute.type !== "JSXAttribute" ||
    jsxName(attribute.name) !== "aria-hidden"
  ) {
    return false;
  }
  const { value } = attribute;
  if (value === null || value === undefined) {
    return true;
  }
  if (isAstNode(value) && value.type === "Literal") {
    return value.value === "true";
  }
  if (isAstNode(value) && value.type === "JSXExpressionContainer") {
    const expression: unknown = value.expression;
    return isAstNode(expression) && expression.type === "Literal"
      ? expression.value === true || expression.value === "true"
      : false;
  }
  return false;
};

const isDecoration = (node: unknown): boolean => {
  const attribute = owningAttribute(node);
  const element = attribute?.parent;
  if (!isAstNode(element)) {
    return false;
  }
  if (jsxName(element.name)?.endsWith("Icon") === true) {
    return true;
  }
  return (
    Array.isArray(element.attributes) &&
    element.attributes.some(isHiddenFromAssistiveTech)
  );
};

// Only unconditional parts may prove a reveal: a conditional touch class
// cannot make its sibling base hide safe when the condition is false.
const staticClassParts = (node: unknown, parts: string[]): void => {
  if (!isAstNode(node)) {
    return;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    parts.push(node.value);
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    staticClassParts(node.expression, parts);
    return;
  }
  if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
    for (const argument of node.arguments) {
      staticClassParts(argument, parts);
    }
    return;
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    for (const quasi of node.quasis) {
      const value: unknown = isAstNode(quasi) ? quasi.value : undefined;
      if (
        typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string"
      ) {
        parts.push(value.raw);
      }
    }
  }
};

const isClassNamePart = (node: unknown): boolean => {
  let current: unknown = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (
      current.type === "LogicalExpression" ||
      current.type === "ConditionalExpression" ||
      current.type === "Property" ||
      current.type === "ArrayExpression" ||
      current.type === "SpreadElement"
    ) {
      return false;
    }
    if (current.type === "JSXAttribute") {
      return jsxName(current.name) === "className";
    }
    if (
      current.type === "JSXElement" ||
      current.type === "VariableDeclarator" ||
      current.type === "Program"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
};

const isHide = (token: string): boolean =>
  HIDDEN.has(classBaseName(token)) && !dependsOnHover(token);

const hidesUntilHover = (value: string): boolean => {
  const tokens = classTokens(value);
  const bases = new Set(tokens.map(classBaseName));
  // An overlay that never takes a pointer is decoration, not a control.
  if (bases.has("pointer-events-none") && !bases.has("pointer-events-auto")) {
    return false;
  }
  const hidesAtRest = tokens.some(isHide);
  if (!hidesAtRest) {
    return false;
  }
  const revealsOnHover = tokens.some(
    (token) => SHOWN.has(classBaseName(token)) && dependsOnHover(token),
  );
  if (!revealsOnHover) {
    return false;
  }
  const tappableStateReveals = tokens.filter(
    (token) =>
      SHOWN.has(classBaseName(token)) &&
      variantsOf(token).some(isTappableStateVariant) &&
      !dependsOnHover(token),
  );
  const touchDecisions = tokens.filter((token) => {
    const variants = variantsOf(token);
    return variants.length > 0 && variants.every(isCoarsePointerVariant);
  });
  const touchBases = new Set(touchDecisions.map(classBaseName));
  if (
    touchBases.has("hidden") ||
    touchBases.has("hidden!") ||
    [...HIDDEN].some((hidden) => touchBases.has(hidden))
  ) {
    return false;
  }
  const revealBases = new Set([
    ...touchBases,
    ...tappableStateReveals.map(classBaseName),
  ]);
  return tokens.some((token) => {
    const base = classBaseName(token);
    if (!isHide(token)) {
      return false;
    }
    const shown = base.startsWith("opacity-") ? "opacity-100" : "visible";
    return (
      !revealBases.has(`${shown}!`) &&
      (base.endsWith("!") || !revealBases.has(shown))
    );
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-hover-only-reveal" },
  rules: {
    "no-hover-only-reveal": {
      meta: {
        type: "problem",
        messages: {
          hoverOnlyReveal:
            "This hides something until hover, and touch screens have no " +
            "hover, so it never appears on a phone or tablet. Add " +
            "`pointer-coarse:opacity-100` (or `pointer-coarse:visible`) so " +
            "coarse pointers show it at rest.",
        },
      },
      createOnce(context) {
        return {
          JSXAttribute(node) {
            if (
              jsxName(node.name) !== "className" ||
              isDecoration(node.value)
            ) {
              return;
            }
            const parts: string[] = [];
            staticClassParts(node.value, parts);
            if (hidesUntilHover(parts.join(" "))) {
              context.report({ node, messageId: "hoverOnlyReveal" });
            }
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              !isClassNamePart(node) &&
              hidesUntilHover(node.value) &&
              !isDecoration(node)
            ) {
              context.report({ node, messageId: "hoverOnlyReveal" });
            }
          },
          TemplateLiteral(node) {
            const parts: string[] = [];
            staticClassParts(node, parts);
            if (
              !isClassNamePart(node) &&
              hidesUntilHover(parts.join(" ")) &&
              !isDecoration(node)
            ) {
              context.report({ node, messageId: "hoverOnlyReveal" });
            }
          },
        };
      },
    },
  },
});
