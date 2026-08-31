// A dialog trigger mounted inside a menu item forces the menu to stay open
// under the dialog.
//
// `<AlertDialogTrigger render={<MenuItem closeOnClick={false} />}>` (or the
// same shape with `DialogTrigger` / `SheetTrigger` / `PopoverTrigger` around
// `MenuItem` / `MenuSubTrigger` / `ContextMenuItem` / `DropdownMenuItem`)
// needs `closeOnClick={false}` precisely because closing the menu would
// unmount the trigger, and the dialog with it. The fix is to lift the dialog
// beside the menu with its own `open` state and have the item request it
// (see `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/row-actions.tsx`
// and `apps/web/src/components/pdf/versions-sidebar.tsx`).
//
// Flags the menu-item element both as the trigger's `render` target and as a
// direct JSX child of the trigger.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, type AstNode } from "./utils.ts";

const TRIGGER_NAMES = new Set([
  "AlertDialogTrigger",
  "DialogTrigger",
  "SheetTrigger",
  "PopoverTrigger",
]);

const MENU_ITEM_NAMES = new Set([
  "MenuItem",
  "MenuSubTrigger",
  "ContextMenuItem",
  "DropdownMenuItem",
]);

const jsxElementName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxElementName(node.name);
  }
  return null;
};

const getOpeningElement = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const nameOfJsxElement = (element: unknown): string | null =>
  jsxElementName(getOpeningElement(element)?.name);

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
        jsxElementName(attribute.name) === name,
    ) ?? null
  );
};

// The JSX element passed as `render={<X />}`, if the value is a literal element.
const getRenderTarget = (openingElement: unknown): AstNode | null => {
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

// The trigger's direct JSX-element children (text and expression children
// are not menu items, so they are skipped).
const getChildElements = (element: unknown): AstNode[] => {
  if (!isAstNode(element) || !Array.isArray(element.children)) {
    return [];
  }
  return element.children.filter(
    (child): child is AstNode =>
      isAstNode(child) && child.type === "JSXElement",
  );
};

// Whether this trigger mounts a menu item as its `render` target or as a
// direct child.
const mountsMenuItem = (triggerElement: unknown): boolean => {
  const openingElement = getOpeningElement(triggerElement);
  const renderName = nameOfJsxElement(getRenderTarget(openingElement));
  if (renderName !== null && MENU_ITEM_NAMES.has(renderName)) {
    return true;
  }
  return getChildElements(triggerElement).some((child) => {
    const childName = nameOfJsxElement(child);
    return childName !== null && MENU_ITEM_NAMES.has(childName);
  });
};

export default eslintCompatPlugin({
  meta: { name: "no-dialog-trigger-menu-item" },
  rules: {
    "no-dialog-trigger-menu-item": {
      meta: {
        type: "problem",
        messages: {
          triggerInsideMenuItem:
            "Do not mount a dialog trigger inside a menu item; the menu cannot close under the dialog. Lift the dialog beside the menu with `open` state and let the item request it.",
        },
      },
      createOnce(context) {
        return {
          JSXElement(node: unknown) {
            const triggerName = nameOfJsxElement(node);
            if (
              triggerName === null ||
              !TRIGGER_NAMES.has(triggerName) ||
              !mountsMenuItem(node)
            ) {
              return;
            }

            context.report({ node, messageId: "triggerInsideMenuItem" });
          },
        };
      },
    },
  },
});
