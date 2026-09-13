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
// A popup that hands its whole body to a component of its own is still the
// owner of that body's action row, even though no popup element encloses the
// row lexically. Such a body is one the popup reaches without crossing a host
// element: once the popup writes layout of its own (`<div>`, `<form>`), what
// hangs below is body content, and a card nested there owns its controls. The
// footer check then spans both halves — the popup that mounts the body and the
// body itself — so a footer on either side owns the row.
//
// Three shapes are deliberately out of scope, because none is the dialog's own
// action row: a row rendered from a callback (a `.map(...)` item's hover
// actions), any pair inside a popup that already mounts a footer, where the
// action row exists and the pair is body content such as a segmented copy/move
// toggle, and a container holding content beside its buttons (a view's root
// with a heading and a back button), which is body layout, not a band.

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

// The name a function is declared under, so a component boundary can be told
// from an anonymous callback: `function Body()` and `const Body = () => …`
// both name `Body`, while a `.map(...)` argument names nothing.
const functionName = (node: AstNode): string | null => {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  ) {
    return isAstNode(node.id) && typeof node.id.name === "string"
      ? node.id.name
      : null;
  }
  const parent = isAstNode(node.parent) ? node.parent : null;
  return parent?.type === "VariableDeclarator" &&
    isAstNode(parent.id) &&
    parent.id.type === "Identifier" &&
    typeof parent.id.name === "string"
    ? parent.id.name
    : null;
};

// Every node under `root`, reached without assuming a shape: the walk has to
// cross statements and expressions a JSX-only traversal never sees.
const everyNode = (root: AstNode): AstNode[] => {
  const out: AstNode[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
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
    out.push(current);
    for (const [key, value] of Object.entries(current)) {
      // `parent` walks back out of the subtree under inspection.
      if (key !== "parent" && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return out;
};

// JSX resolves a capitalised name to a component and a lowercase one to a host
// element, which is how a popup's own layout is told from what it delegates.
const COMPONENT_NAME = /^[A-Z]/u;

const isComponentName = (name: string): boolean => COMPONENT_NAME.test(name);

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

// The elements a row renders one level down: fragments, conditionals and
// expression containers are stepped through, elements are not. An action row
// holds actions and nothing else, so a container with a heading, a field, or a
// list beside its buttons is body layout rather than the dialog's action band.
const collectChildElements = (value: unknown, out: AstNode[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChildElements(entry, out);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  switch (value.type) {
    case "JSXElement": {
      out.push(value);
      return;
    }
    case "JSXFragment": {
      collectChildElements(value.children, out);
      return;
    }
    case "JSXExpressionContainer": {
      collectChildElements(value.expression, out);
      return;
    }
    case "ConditionalExpression": {
      collectChildElements(value.consequent, out);
      collectChildElements(value.alternate, out);
      return;
    }
    case "LogicalExpression": {
      collectChildElements(value.left, out);
      collectChildElements(value.right, out);
      return;
    }
    case "ArrayExpression": {
      collectChildElements(value.elements, out);
      return;
    }
    default:
  }
};

const childElements = (node: unknown): AstNode[] => {
  if (!isAstNode(node)) {
    return [];
  }
  const out: AstNode[] = [];
  collectChildElements(node.children, out);
  return out;
};

// The components a popup hands its whole body to, reached without crossing a
// host element. Once the popup writes layout of its own (`<div>`, `<form>`),
// what hangs below it is body content: a nested card's own controls are that
// card's, not the dialog's band.
const collectDelegatedBodies = (value: unknown, out: AstNode[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDelegatedBodies(entry, out);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  switch (value.type) {
    case "JSXElement": {
      const name = elementName(value);
      if (name === null || !isComponentName(name)) {
        return;
      }
      out.push(value);
      if (isAstNode(value.openingElement)) {
        collectDelegatedBodies(value.openingElement.attributes, out);
      }
      collectDelegatedBodies(value.children, out);
      return;
    }
    case "JSXFragment": {
      collectDelegatedBodies(value.children, out);
      return;
    }
    case "JSXAttribute": {
      collectDelegatedBodies(value.value, out);
      return;
    }
    case "JSXExpressionContainer": {
      collectDelegatedBodies(value.expression, out);
      return;
    }
    case "ConditionalExpression": {
      collectDelegatedBodies(value.consequent, out);
      collectDelegatedBodies(value.alternate, out);
      return;
    }
    case "LogicalExpression": {
      collectDelegatedBodies(value.left, out);
      collectDelegatedBodies(value.right, out);
      return;
    }
    case "ArrayExpression": {
      collectDelegatedBodies(value.elements, out);
      return;
    }
    default:
  }
};

const delegatedBodies = (popup: AstNode): AstNode[] => {
  const out: AstNode[] = [];
  collectDelegatedBodies(popup.children, out);
  return out;
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
        // Components this file renders inside a popup, mapped to whether any
        // popup mounting them already owns a footer.
        const popupBodies = new Map<string, boolean>();

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
        // action pair and holds nothing but actions, so a wrapper is never
        // reported for the row inside it and a view's root container is never
        // mistaken for one.
        const ownsTheActionRow = (node: unknown): boolean => {
          const descendants = renderedElements(node).filter(
            (element) => element !== node,
          );
          if (actionCount(descendants) < 2) {
            return false;
          }
          if (
            !childElements(node).every(
              (child) => actionCount(renderedElements(child)) > 0,
            )
          ) {
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
        const containsFooter = (node: AstNode): boolean =>
          everyNode(node).some((current) => {
            const name = elementName(current);
            return name !== null && footerLocals.has(name);
          });

        // The components this file hands a popup as its body. A popup's body
        // often lives in its own component, and that component's action row is
        // still the dialog's, so the lexical walk has to be able to leave it.
        const collectPopupBodies = (program: unknown) => {
          popupBodies.clear();
          if (!isAstNode(program)) {
            return;
          }
          for (const node of everyNode(program)) {
            const popupName = elementName(node);
            if (popupName === null || !contentLocals.has(popupName)) {
              continue;
            }
            const popupOwnsFooter = containsFooter(node);
            for (const element of delegatedBodies(node)) {
              const name = elementName(element);
              if (
                name === null ||
                contentLocals.has(name) ||
                footerLocals.has(name) ||
                fieldLocals.has(name) ||
                buttonLocals.has(name)
              ) {
                continue;
              }
              popupBodies.set(
                name,
                (popupBodies.get(name) ?? false) || popupOwnsFooter,
              );
            }
          }
        };

        // True when this row is the popup's own action row: a dialog popup
        // ancestor that mounts no footer of its own, with no footer, form row,
        // or callback boundary in between. A body component the popup renders
        // ends the walk the same way the popup element does; any other
        // function in between is a callback rendering rows of its own items.
        const isTheDialogsOwnRow = (node: unknown): boolean => {
          if (!isAstNode(node)) {
            return false;
          }
          let current = isAstNode(node.parent) ? node.parent : null;
          while (current !== null) {
            if (FUNCTION_BOUNDARIES.has(current.type)) {
              const owner = functionName(current);
              const popupOwnsFooter =
                owner === null ? undefined : popupBodies.get(owner);
              return popupOwnsFooter === false && !containsFooter(current);
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
          Program(program) {
            collectImports(program);
            collectPopupBodies(program);
          },
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
