// Require every matter (workspace) link to declare its affordance.
//
// A matter is shown in two structurally different ways:
//   1. A browsable listing item (sidebar, matters grid/table, chat
//      landing) — these MUST carry the shared right-click menu so every
//      surface offers the same rename/pin/copy/delete actions.
//   2. An inline reference (breadcrumbs, side panels, task rows,
//      contact-scoped lists) — navigation only, intentionally no menu.
//
// A raw `<Link to="/workspaces/$workspaceId">` (or any element passing
// that `to`) hides which one it is, so a new listing can silently ship
// without the menu. This rule forbids the raw form and forces a choice:
//   - listing  → wrap the trigger in `<MatterContextMenu>` (or wire it
//                with `useMatterContextMenu` for elements that can't be
//                wrapped, e.g. a table `<TableRow>`),
//   - reference → use `<MatterRefLink workspaceId={...}>`.
//
// Scope: JSX links only. Imperative `navigate({ to: ... })`, `redirect()`,
// and `<Navigate>` are route control flow, not user-facing affordances,
// and are intentionally not covered.

import { isStringLiteral } from "./utils.ts";

const MATTER_ROUTE = "/workspaces/$workspaceId";

// Files that legitimately render a raw matter link:
//   - the two sanctioned primitives themselves,
//   - the sidebar, whose bespoke row wires the shared menu via
//     `useMatterActions` rather than the `<MatterContextMenu>` wrapper,
//   - the active-matter breadcrumb, which carries its own in-place
//     rename + context menu.
const SANCTIONED_FILES = [
  "matter-ref-link.tsx",
  "matter-context-menu.tsx",
  "app-sidebar.tsx",
  "workspace-breadcrumb.tsx",
];

// A matter link nested inside this element already carries the shared
// menu, so its `to` is sanctioned wherever it appears.
const LISTING_WRAPPER = "MatterContextMenu";

// `<Navigate>` is a redirect, not a clickable affordance.
const REDIRECT_ELEMENTS = new Set(["Navigate"]);

type AstNode = { type: string } & Record<string, unknown>;

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

const getStringAttrValue = (value: unknown): string | null => {
  if (isStringLiteral(value)) {
    return value.value;
  }
  if (
    isAstNode(value) &&
    value.type === "JSXExpressionContainer" &&
    isStringLiteral(value.expression)
  ) {
    return value.expression.value;
  }
  return null;
};

const hasListingWrapperAncestor = (node: unknown): boolean => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const openingElement = current.openingElement;
      if (
        isAstNode(openingElement) &&
        getJsxName(openingElement.name) === LISTING_WRAPPER
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

const filenameOf = (context: {
  filename?: string;
  getFilename?: () => string;
}): string => context.filename ?? context.getFilename?.() ?? "";

export default {
  meta: { name: "require-matter-affordance" },
  rules: {
    "require-matter-affordance": {
      meta: {
        type: "problem",
        messages: {
          rawMatterLink:
            `<{{tag}} to="${MATTER_ROUTE}"> hides whether this is a ` +
            "browsable matter listing or an inline reference. For a " +
            "listing, wrap the trigger in <MatterContextMenu> (or use " +
            "useMatterContextMenu) so the shared right-click menu is " +
            "present. For a reference, use <MatterRefLink workspaceId=" +
            "{...}>.",
        },
      },
      create(context: {
        filename?: string;
        getFilename?: () => string;
        report: (descriptor: {
          node: unknown;
          messageId: string;
          data?: Record<string, string>;
        }) => void;
      }) {
        const filename = filenameOf(context);
        if (SANCTIONED_FILES.some((file) => filename.endsWith(file))) {
          return {};
        }

        return {
          JSXAttribute(node: AstNode) {
            if (getJsxName(node.name) !== "to") {
              return;
            }
            if (getStringAttrValue(node.value) !== MATTER_ROUTE) {
              return;
            }

            const opening = node.parent;
            if (!isAstNode(opening) || opening.type !== "JSXOpeningElement") {
              return;
            }
            const tag = getJsxName(opening.name);
            if (tag === null || REDIRECT_ELEMENTS.has(tag)) {
              return;
            }
            if (hasListingWrapperAncestor(opening)) {
              return;
            }

            context.report({
              node,
              messageId: "rawMatterLink",
              data: { tag },
            });
          },
        };
      },
    },
  },
};
