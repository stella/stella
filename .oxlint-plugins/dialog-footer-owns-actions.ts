// A dialog's action row belongs to `DialogFooter` / `AlertDialogFooter` /
// `SheetFooter`. Those primitives paint a full-bleed band: the popup's own
// padding stops at the panel, and the footer re-applies its horizontal
// padding, border, and muted ground edge to edge, reversing the button order
// on narrow viewports (packages/ui/src/components/dialog.tsx). A hand-rolled
// `<div className="flex justify-end gap-2">` sits inside the panel padding
// instead, so the band renders inset and loses the border and the stacking
// behaviour.
//
// Flagged, inside a dialog/sheet popup:
//   <div className="flex justify-end gap-2">
//     <Button variant="ghost">Cancel</Button>
//     <Button type="submit">Save</Button>
//   </div>
// Allowed:
//   the same pair inside <DialogFooter>, a single button anywhere, buttons
//   inside a `Field` row, and buttons rendered from a list callback.
//
// Only the innermost qualifying element is reported, so a wrapper is not
// flagged for the row it contains. Every component resolves through its
// `@stll/ui` import.
//
// Two shapes are deliberately out of scope, because neither is the dialog's
// own action row: a row rendered from a callback (a `.map(...)` item's hover
// actions), and any pair inside a popup that already mounts a footer, where
// the action row exists and the pair is body content such as a segmented
// copy/move toggle.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportLocalName,
  getImportedName,
  isAstNode,
  type AstNode,
} from "./utils.ts";

const UI_MODULE_PREFIX = "@stll/ui";

const CONTENT_IMPORTS = new Set([
  "AlertDialogContent",
  "AlertDialogPopup",
  "DialogContent",
  "DialogPopup",
  "SheetContent",
  "SheetPopup",
]);
const FOOTER_IMPORTS = new Set([
  "AlertDialogFooter",
  "DialogFooter",
  "SheetFooter",
]);
// A form row owns its own controls; its buttons are field affordances, not the
// dialog's actions.
const FIELD_IMPORTS = new Set(["Field", "FieldControl", "FieldItem"]);
const BUTTON_IMPORTS = new Set(["Button"]);

// Host elements that carry no design-system behaviour of their own.
const PLAIN_ROW_ELEMENTS = new Set(["div", "footer", "section"]);

// A callback between the row and the popup means the row is rendered per item,
// not once as the dialog's actions.
const FUNCTION_BOUNDARIES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const jsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxName(node.name);
  }
  return null;
};

const elementName = (element: unknown): string | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement)
    ? jsxName(element.openingElement.name)
    : null;
};

// JSX elements rendered in place under `node`, including through fragments,
// conditionals, arrays, and literal element props such as
// `render={<Button />}`. Call expressions and function bodies are not
// traversed: a `.map(...)` list or a render callback produces rows of its own
// items, which is not this element's action row.
const collectRenderedElements = (value: unknown, out: AstNode[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRenderedElements(entry, out);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  switch (value.type) {
    case "JSXElement": {
      out.push(value);
      if (isAstNode(value.openingElement)) {
        collectRenderedElements(value.openingElement.attributes, out);
      }
      collectRenderedElements(value.children, out);
      return;
    }
    case "JSXFragment": {
      collectRenderedElements(value.children, out);
      return;
    }
    case "JSXAttribute": {
      collectRenderedElements(value.value, out);
      return;
    }
    case "JSXExpressionContainer": {
      collectRenderedElements(value.expression, out);
      return;
    }
    case "ConditionalExpression": {
      collectRenderedElements(value.consequent, out);
      collectRenderedElements(value.alternate, out);
      return;
    }
    case "LogicalExpression": {
      collectRenderedElements(value.left, out);
      collectRenderedElements(value.right, out);
      return;
    }
    case "ArrayExpression": {
      collectRenderedElements(value.elements, out);
      return;
    }
    default:
  }
};

const renderedElements = (node: unknown): AstNode[] => {
  const out: AstNode[] = [];
  collectRenderedElements(node, out);
  return out;
};

export default eslintCompatPlugin({
  meta: { name: "dialog-footer-owns-actions" },
  rules: {
    "dialog-footer-owns-actions": {
      meta: {
        type: "problem",
        messages: {
          handRolledActionRow:
            "Use DialogFooter (or AlertDialogFooter / SheetFooter) for a dialog's action row. A hand-rolled {{tag}} sits inside the panel padding, so the band renders inset and loses the footer's border and narrow-viewport stacking.",
        },
      },
      createOnce(context) {
        const contentLocals = new Set<string>();
        const footerLocals = new Set<string>();
        const fieldLocals = new Set<string>();
        const buttonLocals = new Set<string>();

        const collectImports = (program: unknown) => {
          for (const locals of [
            contentLocals,
            footerLocals,
            fieldLocals,
            buttonLocals,
          ]) {
            locals.clear();
          }
          if (!isAstNode(program) || !Array.isArray(program.body)) {
            return;
          }
          for (const statement of program.body) {
            if (
              !isAstNode(statement) ||
              statement.type !== "ImportDeclaration" ||
              !isAstNode(statement.source) ||
              typeof statement.source.value !== "string" ||
              !statement.source.value.startsWith(UI_MODULE_PREFIX) ||
              !Array.isArray(statement.specifiers)
            ) {
              continue;
            }
            for (const specifier of statement.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (imported === null || local === null) {
                continue;
              }
              if (CONTENT_IMPORTS.has(imported)) {
                contentLocals.add(local);
              }
              if (FOOTER_IMPORTS.has(imported)) {
                footerLocals.add(local);
              }
              if (FIELD_IMPORTS.has(imported)) {
                fieldLocals.add(local);
              }
              if (BUTTON_IMPORTS.has(imported)) {
                buttonLocals.add(local);
              }
            }
          }
        };

        const actionCount = (elements: readonly AstNode[]): number =>
          elements.filter((element) => {
            const name = elementName(element);
            return name !== null && buttonLocals.has(name);
          }).length;

        const isPlainRow = (element: unknown): boolean => {
          const name = elementName(element);
          return name !== null && PLAIN_ROW_ELEMENTS.has(name);
        };

        // True when this element is the innermost plain host carrying the
        // action pair, so a wrapper is never reported for the row inside it.
        const ownsTheActionRow = (node: AstNode): boolean => {
          const descendants = renderedElements(node).filter(
            (element) => element !== node,
          );
          if (actionCount(descendants) < 2) {
            return false;
          }
          return !descendants.some(
            (element) =>
              isPlainRow(element) &&
              actionCount(
                renderedElements(element).filter((inner) => inner !== element),
              ) >= 2,
          );
        };

        // Any footer under `node`, however it is reached. The walk is
        // deliberately untyped and exhaustive, unlike the in-place walk above:
        // a footer rendered from a helper or a branch still means the popup
        // has its action row.
        const containsFooter = (node: AstNode): boolean => {
          const seen = new Set<unknown>();
          const pending: unknown[] = [node];
          while (pending.length > 0) {
            const current = pending.pop();
            if (Array.isArray(current)) {
              pending.push(...current);
              continue;
            }
            if (!isAstNode(current) || seen.has(current)) {
              continue;
            }
            seen.add(current);
            const name = elementName(current);
            if (name !== null && footerLocals.has(name)) {
              return true;
            }
            for (const [key, value] of Object.entries(current)) {
              // `parent` walks back out of the subtree under inspection.
              if (key !== "parent" && typeof value === "object") {
                pending.push(value);
              }
            }
          }
          return false;
        };

        // True when this row is the popup's own action row: a dialog popup
        // ancestor that mounts no footer of its own, with no footer, form row,
        // or callback boundary in between.
        const isTheDialogsOwnRow = (node: AstNode): boolean => {
          let current = isAstNode(node.parent) ? node.parent : null;
          while (current !== null) {
            if (FUNCTION_BOUNDARIES.has(current.type)) {
              return false;
            }
            const name = elementName(current);
            if (name !== null) {
              if (footerLocals.has(name) || fieldLocals.has(name)) {
                return false;
              }
              if (contentLocals.has(name)) {
                return !containsFooter(current);
              }
            }
            current = isAstNode(current.parent) ? current.parent : null;
          }
          return false;
        };

        return {
          Program: collectImports,
          JSXElement(node) {
            if (
              !isPlainRow(node) ||
              !ownsTheActionRow(node) ||
              !isTheDialogsOwnRow(node)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "handRolledActionRow",
              data: { tag: elementName(node) ?? "element" },
            });
          },
        };
      },
    },
  },
});
