// Formatted dates and relative times inside table cells or list items must
// reveal the full timestamp on hover/focus via <Timestamp> or <Tooltip>.
//
// Flagged:
//   <TableCell>{formatter.dateTime(date, MEDIUM_DATE_FORMAT)}</TableCell>
//   <ListItem>{formatRelativeTime(item.createdAt)}</ListItem>
// Allowed:
//   <TableCell><Timestamp value={item.createdAt} /></TableCell>
//   <TableCell><Tooltip content={formatFullTimestamp(date)} render={<span />}>{formatter.dateTime(date)}</Tooltip></TableCell>

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { filenameForContext, isAstNode, jsxName } from "./utils.ts";

const RULE_NAME = "require-timestamp-tooltip";
const CONTAINER_NAMES = new Set(["TableCell", "TableCellFace", "ListItem"]);
const TOOLTIP_NAMES = new Set(["Tooltip", "Timestamp"]);
const DIRECT_FORMATTERS = new Set([
  "formatRelativeTime",
  "formatRelativeTimeIn",
  "relativeTime",
]);

type LineContext = {
  sourceCode: { getLocFromIndex: (index: number) => { line: number } };
};

const lineOf = (context: LineContext, node: Ranged): number => {
  const [start] = node.range;
  return context.sourceCode.getLocFromIndex(start).line;
};

const isTimestampFormatCall = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const callee = node.callee;
  if (!isAstNode(callee)) {
    return false;
  }
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    return DIRECT_FORMATTERS.has(callee.name);
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    isAstNode(callee.property) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "dateTime"
  ) {
    return true;
  }
  return false;
};

const insideContainerWithoutTooltip = (node: unknown): boolean => {
  let cursor: unknown = node;
  let insideJsxExpr = false;
  while (isAstNode(cursor)) {
    if (cursor.type === "JSXExpressionContainer") {
      insideJsxExpr = true;
    }
    if (cursor.type === "JSXAttribute") {
      // Formatting inside an attribute (e.g. Tooltip content={...} or aria-label) is not bare rendered text.
      return false;
    }
    if (cursor.type === "JSXElement" && isAstNode(cursor.openingElement)) {
      const tag = jsxName(cursor.openingElement.name);
      if (tag !== null && TOOLTIP_NAMES.has(tag)) {
        return false;
      }
      if (tag !== null && CONTAINER_NAMES.has(tag)) {
        return insideJsxExpr;
      }
    }
    cursor = cursor.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "suggestion",
        messages: {
          missingTooltip:
            "Dates and relative times in table cells or list items must show the full timestamp on hover. Use <Timestamp value={...} /> or wrap in <Tooltip content={formatFullTimestamp(...)}>.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          CallExpression(node) {
            if (!isTimestampFormatCall(node)) {
              return;
            }
            if (
              insideContainerWithoutTooltip(node) &&
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line: lineOf(context, node),
              })
            ) {
              context.report({ node, messageId: "missingTooltip" });
            }
          },
        };
      },
    },
  },
});
