// Read the matter view on screen from the route match, never the URL path.
//
// The `$viewId` route decides which path segment is a view: a matter's other
// pages (`reports/$exportId`, `correspondence/$correspondenceId`) sit at the
// same depth and match their own routes. A path parser restates that route
// tree and drifts from it, reading `reports` as a view id. The owner,
// apps/web/src/lib/workspaces/use-workspace-view-params.ts, reads the match:
// `useCurrentWorkspaceView()` in render, `getCurrentWorkspaceView(router)` in
// an event handler.
//
// The rule proves one local property: a segment read off a URL path
// (`split`, `match`, `matchAll`, `slice`, `substring`, `substr`, `replace`,
// `replaceAll` called on a `pathname` binding or `.pathname` member, or a
// regex `exec` given one) does not sit in a function, or under an enclosing
// function or module, that spells a matter route (`workspaces/` in a string,
// template or regex literal, or a bare `"workspaces"` segment). Route
// templates (`/workspaces/$workspaceId`), object keys and module sources
// spell no path. A route prefix imported from another module, or a path
// bound to another name first, is out of reach. Boolean checks
// (`test`, `startsWith`, `endsWith`, `includes`) read no segment and are
// allowed. The removed path parser `getCurrentWorkspaceViewId` may not be
// imported or declared again.
//
// Flags:
//   const prefix = `/workspaces/${workspaceId}/`;
//   const viewId = pathname.slice(prefix.length).split("/").at(0);
//   const [, , , viewId] = location.pathname.split("/");
//   /^\/workspaces\/[^/]+\/([^/]+)/u.exec(router.state.location.pathname);
//
// Allows:
//   const currentView = getCurrentWorkspaceView(router);
//   new RegExp(`^/workspaces/${workspaceId}/[^/]+/document`, "u").test(pathname);
//   const name = url.pathname.split("/").at(-1);

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const PATHNAME = "pathname";
const REMOVED_PATH_PARSER = "getCurrentWorkspaceViewId";
// `workspaces/` in a path, a regex (`workspaces\/`) or a template chunk, or
// the bare segment a split path is compared against.
const WORKSPACE_ROUTE_TEXT = /workspaces\\?\/|^workspaces$/u;
// A TanStack route template (`/workspaces/$workspaceId`) names a route; it
// parses nothing.
const ROUTE_TEMPLATE_TEXT = /\/\$[A-Za-z_]/u;
const MODULE_SOURCE_PARENTS = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "ImportExpression",
]);
const SEGMENT_METHODS = new Set([
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "substr",
  "substring",
]);
const SCOPE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "Program",
]);

/** Whether `value` is a URL path: a `pathname` binding or `.pathname`. */
const isPathname = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  if (node.type === "Identifier") {
    return getPropertyName(node) === PATHNAME;
  }
  return (
    node.type === "MemberExpression" && memberPropertyName(node) === PATHNAME
  );
};

/** Whether `call` reads a segment off a URL path. */
const readsPathSegment = (call: AstNode): boolean => {
  const callee = unwrapExpression(call.callee);
  if (callee === null || callee.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === "exec") {
    return Array.isArray(call.arguments) && isPathname(call.arguments.at(0));
  }
  return (
    method !== null && SEGMENT_METHODS.has(method) && isPathname(callee.object)
  );
};

/** The functions enclosing `node`, innermost first, then the module. */
const enclosingScopes = (node: AstNode): AstNode[] => {
  const scopes: AstNode[] = [];
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (SCOPE_TYPES.has(current.type)) {
      scopes.push(current);
    }
    current = current.parent;
  }
  return scopes;
};

/** Whether `node` names a module or a key rather than a path. */
const isNonPathPosition = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (MODULE_SOURCE_PARENTS.has(parent.type)) {
    return parent.source === node;
  }
  return parent.type === "Property" && parent.key === node;
};

/** The literal text of a string, template chunk or regex. */
const literalText = (node: AstNode): string | null => {
  if (node.type === "TemplateElement") {
    const value = node.value;
    return typeof value === "object" &&
      value !== null &&
      "raw" in value &&
      typeof value.raw === "string"
      ? value.raw
      : null;
  }
  if (typeof node.value === "string") {
    return node.value;
  }
  const regex = node.regex;
  return typeof regex === "object" &&
    regex !== null &&
    "pattern" in regex &&
    typeof regex.pattern === "string"
    ? regex.pattern
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-view-id-from-path" },
  rules: {
    "no-view-id-from-path": {
      meta: {
        type: "problem",
        messages: {
          pathSegment:
            "Do not read a matter route segment off the URL path: the route match names the view on screen. Use useCurrentWorkspaceView() in render or getCurrentWorkspaceView(router) in a handler, from @/lib/workspaces/use-workspace-view-params.",
          removedParser:
            "getCurrentWorkspaceViewId parsed the view from the URL path. Use useCurrentWorkspaceView() or getCurrentWorkspaceView(router) from @/lib/workspaces/use-workspace-view-params.",
        },
        schema: [],
      },
      createOnce(context) {
        let routeScopes = new Set<AstNode>();
        let segmentReads: AstNode[] = [];
        const markRouteText = (node: AstNode) => {
          const text = literalText(node);
          const scope = enclosingScopes(node).at(0);
          if (
            text !== null &&
            scope &&
            WORKSPACE_ROUTE_TEXT.test(text) &&
            !ROUTE_TEMPLATE_TEXT.test(text) &&
            !isNonPathPosition(node)
          ) {
            routeScopes.add(scope);
          }
        };
        const reportRemovedName = (node: unknown) => {
          if (isIdentifier(node, REMOVED_PATH_PARSER)) {
            context.report({ node, messageId: "removedParser" });
          }
        };
        return {
          before() {
            routeScopes = new Set();
            segmentReads = [];
          },
          Literal(node) {
            if (isAstNode(node)) {
              markRouteText(node);
            }
          },
          TemplateElement(node) {
            if (isAstNode(node)) {
              markRouteText(node);
            }
          },
          CallExpression(node) {
            if (isAstNode(node) && readsPathSegment(node)) {
              segmentReads.push(node);
            }
          },
          ImportSpecifier(node) {
            if (getImportedName(node) === REMOVED_PATH_PARSER) {
              context.report({ node, messageId: "removedParser" });
            }
          },
          FunctionDeclaration(node) {
            reportRemovedName(node.id);
          },
          VariableDeclarator(node) {
            reportRemovedName(node.id);
          },
          "Program:exit"() {
            const spellsRoute = (scope: AstNode) => routeScopes.has(scope);
            for (const node of segmentReads) {
              if (enclosingScopes(node).some(spellsRoute)) {
                context.report({ node, messageId: "pathSegment" });
              }
            }
          },
        };
      },
    },
  },
});
