// A table or list row that exposes a "…" / "⋮" actions Menu must wire its
// actions through EntityActions + EntityActionsButton (@stll/ui/entity-actions)
// so right-click and the button always open the same menu.
//
// Flagged:
//   <TableRow><TableCell><Menu><MenuTrigger><EllipsisVerticalIcon /></MenuTrigger></Menu></TableCell></TableRow>
// Allowed:
//   <EntityActions actions={actions} label="Actions" render={<TableRow />}>
//     <TableCell><EntityActionsButton /></TableCell>
//   </EntityActions>

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { filenameForContext, isAstNode, jsxName } from "./utils.ts";

const RULE_NAME = "require-entity-actions-row";
const ROW_NAMES = new Set(["TableRow", "ListItem"]);
const ELLIPSIS_ICONS = new Set([
  "EllipsisVerticalIcon",
  "EllipsisIcon",
  "MoreHorizontalIcon",
  "MoreVerticalIcon",
]);

type LineContext = {
  sourceCode: { getLocFromIndex: (index: number) => { line: number } };
};

const lineOf = (
  context: LineContext,
  node: Record<string, unknown>,
): number => {
  const range = node.range;
  const start = Array.isArray(range) ? range[0] : undefined;
  return typeof start === "number"
    ? context.sourceCode.getLocFromIndex(start).line
    : 1;
};

const hasAncestorTag = (node: unknown, names: ReadonlySet<string>): boolean => {
  let cursor: unknown = node;
  while (isAstNode(cursor)) {
    cursor = cursor.parent;
    if (
      isAstNode(cursor) &&
      cursor.type === "JSXElement" &&
      isAstNode(cursor.openingElement)
    ) {
      const tag = jsxName(cursor.openingElement.name);
      if (tag !== null && names.has(tag)) {
        return true;
      }
    }
  }
  return false;
};

const containsEllipsisIcon = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "JSXOpeningElement" &&
    ELLIPSIS_ICONS.has(jsxName(node.name) ?? "")
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some(containsEllipsisIcon)) {
        return true;
      }
    } else if (containsEllipsisIcon(value)) {
      return true;
    }
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          useEntityActions:
            "Row action menus must use EntityActions + EntityActionsButton (@stll/ui/entity-actions) so right-clicking the row opens the same actions as the button.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXElement(node) {
            if (!isAstNode(node.openingElement)) {
              return;
            }
            if (jsxName(node.openingElement.name) !== "Menu") {
              return;
            }
            if (
              hasAncestorTag(node, ROW_NAMES) &&
              containsEllipsisIcon(node) &&
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line: lineOf(context, node),
              })
            ) {
              context.report({
                node: node.openingElement,
                messageId: "useEntityActions",
              });
            }
          },
        };
      },
    },
  },
});
