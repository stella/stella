// Right-click opens an object's own actions through `EntityActions`
// (`@stll/ui/entity-actions`), not through a hand-written `contextmenu`
// handler. The owner takes ONE action list and renders both the object's
// "…" button and its right-click menu from it, so the two cannot drift; it
// keeps the native menu for Shift + right-click, editable text, links and
// selected text; and a nested object answers before the one around it. A
// hand-written handler gets none of that: whether something reacts to a
// right-click, and with which items, depended on who wired it.
//
// Invariant: in `apps/web` and `apps/desktop`, nothing but the owners in
// CONTEXT_MENU_OWNERS listens for `contextmenu`.
//
// Rejected:
//   <div onContextMenu={open} />               // JSX handler, any element
//   <div onContextMenuCapture={open} />
//   const props = { onContextMenu: open };     // a props object spread later
//   element.addEventListener("contextmenu", h) // a DOM listener
//
// Accepted: `onContextMenu` in a type, a destructured parameter (the element
// it reaches is reported where it is passed), and a test file's synthetic
// `fireEvent.contextMenu`. `on<event>` assignment is already rejected by
// `unicorn/prefer-add-event-listener`.
//
// Merged handlers are carried per file in `scripts/design-lint-baseline.json`
// until they move onto the owner.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  staticStringValue,
} from "./utils.ts";

/**
 * The sanctioned listeners, as repository-relative paths. Add an owner here,
 * with the reason it is one, rather than exempting a caller.
 */
export const CONTEXT_MENU_OWNERS: readonly string[] = [
  // An object's actions: the "…" button and the right-click menu from one list.
  "packages/ui/src/components/entity-actions.tsx",
  // The base-ui right-click primitive EntityActions' item renderer shares.
  "packages/ui/src/components/context-menu.tsx",
  // The desktop webview: no browser menu (reload, inspect) off editable or
  // selected text, installed once for every window.
  "apps/desktop/src/shared/native-context-menu.ts",
];

const isContextMenuOwner = (filename: string): boolean =>
  CONTEXT_MENU_OWNERS.some(
    (owner) => filename === owner || filename.endsWith(`/${owner}`),
  );

const HANDLER_PROPS: ReadonlySet<string> = new Set([
  "onContextMenu",
  "onContextMenuCapture",
]);

const CONTEXT_MENU_EVENT = "contextmenu";

const LISTENER_METHODS: ReadonlySet<string> = new Set(["addEventListener"]);

/** The static name a member expression reads, or null. */
const memberName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  return node.computed === true
    ? staticStringValue(node.property)
    : getPropertyName(node.property);
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-context-menu" },
  rules: {
    "no-raw-context-menu": {
      meta: {
        type: "problem",
        messages: {
          rawContextMenu:
            "Open an object's actions on right-click through EntityActions " +
            "from @stll/ui/entity-actions, not a raw `{{name}}`: the owner " +
            "renders the object's actions button and its right-click menu " +
            "from one action list, keeps the native menu for Shift + " +
            "right-click, editable text, links and selected text, and lets " +
            "a nested object answer first.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isContextMenuOwner(filenameForContext(context));
          },
          JSXAttribute(node) {
            if (
              node.name.type === "JSXIdentifier" &&
              HANDLER_PROPS.has(node.name.name)
            ) {
              context.report({
                node,
                messageId: "rawContextMenu",
                data: { name: node.name.name },
              });
            }
          },
          Property(node) {
            if (node.parent.type !== "ObjectExpression") {
              return;
            }
            const name =
              node.computed === true
                ? staticStringValue(node.key)
                : getPropertyName(node.key);
            if (name !== null && HANDLER_PROPS.has(name)) {
              context.report({
                node,
                messageId: "rawContextMenu",
                data: { name },
              });
            }
          },
          CallExpression(node) {
            const method = memberName(node.callee);
            if (
              method !== null &&
              LISTENER_METHODS.has(method) &&
              staticStringValue(node.arguments.at(0)) === CONTEXT_MENU_EVENT
            ) {
              context.report({
                node,
                messageId: "rawContextMenu",
                data: { name: `${method}("${CONTEXT_MENU_EVENT}")` },
              });
            }
          },
        };
      },
    },
  },
});
