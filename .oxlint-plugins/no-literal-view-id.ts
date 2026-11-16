// Keep the matter route's default-view slug in its owner.
//
// `"all"` is the `$viewId` that names no view: the matter route resolves it
// to the matter's first view. Hardcoded at a navigation, it sends the reader
// to the Overview from whatever view they were in, and a later "back" lands
// there too. A destination inside the matter on screen keeps the view on
// screen (`useWorkspaceViewParams` / `resolveWorkspaceViewParams`); only a
// destination with no view to keep names `DEFAULT_WORKSPACE_VIEW_ID`, both in
// apps/web/src/lib/workspaces/.
//
// The rule proves one local property: the string `"all"` does not reach a
// view-id position. A view-id position is a property, JSX attribute,
// variable, parameter default, assignment target or type member named
// `viewId`, `…ViewId` or `…VIEW_ID`, or the other side of a `??`, `||`, `===`
// or `!==` whose operand reads such a name. Conditional, logical and type
// wrappers between the literal and that position are looked through. A slug
// built at runtime, or bound to an unrelated name first, is out of reach.
//
// Flags:
//   params: { workspaceId, viewId: "all" }
//   <PeekPdfViewer viewId="all" />
//   const viewId = match?.params.viewId ?? "all";
//   select: (params) => params.viewId ?? "all"
//   type Route = { params: { viewId: "all" } };
//   const ALL_VIEW_ID = "all";
//
// Allows:
//   params: useWorkspaceViewParams(workspaceId)
//   params: { workspaceId, viewId: DEFAULT_WORKSPACE_VIEW_ID }
//   const filter = "all";

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isFileIn,
  memberPropertyName,
  staticStringValue,
} from "./utils.ts";

const DEFAULT_VIEW_SLUG = "all";

// Shrink-only: the module that owns the slug and its resolution.
export const VIEW_ID_OWNERS = [
  "apps/web/src/lib/workspaces/view-params.logic.ts",
];

const VIEW_ID_NAME = /^(?:viewId|\w*ViewId|(?:\w+_)?VIEW_ID)$/u;

const LOOKED_THROUGH = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSLiteralType",
  "TSUnionType",
  "TSTypeAnnotation",
  "JSXExpressionContainer",
]);

const COMPARED_WITH = new Set(["??", "||", "===", "!=="]);

const isViewIdName = (name: string | null): boolean =>
  name !== null && VIEW_ID_NAME.test(name);

/** Whether `node` reads a view-id name: `viewId`, `params.viewId`,
 *  `match?.params.viewId`. */
const readsViewId = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "ChainExpression") {
    return readsViewId(node.expression);
  }
  if (node.type === "Identifier") {
    return isViewIdName(getPropertyName(node));
  }
  return (
    node.type === "MemberExpression" && isViewIdName(memberPropertyName(node))
  );
};

/** The name of the position `child` fills in `parent`, if it is a named
 *  slot: a property value, attribute, binding, default or type member. */
const slotName = (parent: AstNode, child: AstNode): string | null => {
  switch (parent.type) {
    case "Property": {
      return parent.value === child && parent.computed !== true
        ? getPropertyName(parent.key)
        : null;
    }
    case "JSXAttribute": {
      const name = parent.name;
      return isAstNode(name) &&
        name.type === "JSXIdentifier" &&
        typeof name.name === "string"
        ? name.name
        : null;
    }
    case "VariableDeclarator":
    case "PropertyDefinition": {
      const target =
        parent.type === "VariableDeclarator" ? parent.id : parent.key;
      return getPropertyName(target);
    }
    case "AssignmentPattern":
    case "AssignmentExpression": {
      const target = parent.left;
      if (!isAstNode(target) || parent.right !== child) {
        return null;
      }
      return target.type === "MemberExpression"
        ? memberPropertyName(target)
        : getPropertyName(target);
    }
    case "TSPropertySignature": {
      return getPropertyName(parent.key);
    }
    default: {
      return null;
    }
  }
};

const reachesViewIdPosition = (literal: AstNode): boolean => {
  let child = literal;
  let parent = child.parent;
  while (isAstNode(parent)) {
    if (
      (parent.type === "LogicalExpression" ||
        parent.type === "BinaryExpression") &&
      typeof parent.operator === "string" &&
      COMPARED_WITH.has(parent.operator) &&
      readsViewId(parent.left === child ? parent.right : parent.left)
    ) {
      return true;
    }
    if (!LOOKED_THROUGH.has(parent.type)) {
      return isViewIdName(slotName(parent, child));
    }
    child = parent;
    parent = child.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-literal-view-id" },
  rules: {
    "no-literal-view-id": {
      meta: {
        type: "problem",
        messages: {
          literalViewId:
            "Do not hardcode the default view slug. Keep the reader in the view on screen with useWorkspaceViewParams / resolveWorkspaceViewParams; a destination with no view to keep uses DEFAULT_WORKSPACE_VIEW_ID (apps/web/src/lib/workspaces/).",
        },
        schema: [],
      },
      createOnce(context) {
        const check = (node: unknown) => {
          if (
            !isAstNode(node) ||
            staticStringValue(node) !== DEFAULT_VIEW_SLUG ||
            isFileIn(context, VIEW_ID_OWNERS) ||
            !reachesViewIdPosition(node)
          ) {
            return;
          }
          context.report({ node, messageId: "literalViewId" });
        };
        return {
          Literal: check,
          TemplateLiteral: check,
        };
      },
    },
  },
});
