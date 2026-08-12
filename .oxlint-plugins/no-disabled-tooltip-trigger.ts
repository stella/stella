// A tooltip wrapped around a disabled `Button` can never open.
//
// `buttonVariants` carries `disabled:pointer-events-none`, and the browser
// suppresses pointer and focus events on a natively disabled control anyway, so
// the trigger receives no hover and no focus: the popup explaining *why* the
// action is unavailable is unreachable exactly when it is needed.
//
// `Button` closes the hole for the tooltip it owns — given `tooltip`,
// `aria-label`, or `title` it switches a disabled button to the ARIA
// accessible-disabled pattern (`aria-disabled`, focusable, activation blocked).
// It cannot see a tooltip a caller wraps around it from the outside, which is
// the pattern this rule flags.
//
// Flagged: a `Tooltip` / `TooltipTrigger` whose `render` target is a `Button`
// carrying `disabled`, including through intermediate triggers
// (`<Tooltip render={<DialogTrigger render={<Button disabled />} />} />`).
//
// Allowed: `<Button tooltip={...} disabled />`, a tooltip around an enabled
// Button, and any tooltip whose render target is not a Button.

import { eslintCompatPlugin } from "@oxlint/plugins";

type AstNode = { type: string } & Record<string, unknown>;

type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

const TOOLTIP_ELEMENTS = new Set(["Tooltip", "TooltipRoot", "TooltipTrigger"]);

// Following `render` chains costs nothing and no real trigger stack is deeper.
const MAX_RENDER_DEPTH = 8;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

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
  if (node.type === "JSXNamespacedName") {
    return getJsxName(node.name);
  }
  return null;
};

const getOpeningElement = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const getAttribute = (
  openingElement: unknown,
  name: string,
): AstNode | null => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        getJsxName(attribute.name) === name,
    ) ?? null
  );
};

// The JSX element passed as `render={<X />}`, if the value is a literal element.
const getRenderElement = (openingElement: unknown): AstNode | null => {
  const value = getAttribute(openingElement, "render")?.value;
  if (!isAstNode(value)) {
    return null;
  }
  const expression =
    value.type === "JSXExpressionContainer" ? value.expression : value;
  return isAstNode(expression) && expression.type === "JSXElement"
    ? expression
    : null;
};

// Whether this tooltip ends up triggering a `<Button disabled>`.
const triggersDisabledButton = (tooltipElement: unknown): boolean => {
  let element = getRenderElement(getOpeningElement(tooltipElement));
  for (
    let depth = 0;
    element !== null && depth < MAX_RENDER_DEPTH;
    depth += 1
  ) {
    const openingElement = getOpeningElement(element);
    if (
      getJsxName(openingElement?.name) === "Button" &&
      getAttribute(openingElement, "disabled") !== null
    ) {
      return true;
    }
    element = getRenderElement(openingElement);
  }
  return false;
};

const filenameOf = (context: FilenameContext): string =>
  context.filename ?? context.getFilename?.() ?? "";

export default eslintCompatPlugin({
  meta: { name: "no-disabled-tooltip-trigger" },
  rules: {
    "no-disabled-tooltip-trigger": {
      meta: {
        type: "problem",
        messages: {
          unreachableTooltip:
            "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameOf(context).endsWith(".tsx");
          },
          JSXElement(node) {
            const name = getJsxName(getOpeningElement(node)?.name);
            if (
              name === null ||
              !TOOLTIP_ELEMENTS.has(name) ||
              !triggersDisabledButton(node)
            ) {
              return;
            }

            context.report({ node, messageId: "unreachableTooltip" });
          },
        };
      },
    },
  },
});
