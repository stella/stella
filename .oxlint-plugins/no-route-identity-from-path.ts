// Read which matter page is on screen from the route match, never the URL path.
//
// The route tree decides what a path means: `$viewId` names a view, its
// `document` child the document page, and a matter's other pages
// (`reports/$exportId`, `correspondence/$correspondenceId`) sit at the same
// depth and match their own routes. A path parser or path regex restates that
// tree and drifts from it, reading `reports` as a view id or
// `reports/document` as the document page. The owner,
// apps/web/src/lib/workspaces/use-workspace-view-params.ts, reads the matches:
// `useCurrentWorkspaceView()` in render, and `getCurrentWorkspaceView` /
// `getCurrentWorkspaceDocument` over `router.state.matches` in a handler or
// over a route's `beforeLoad` matches.
//
// The rule proves one local property: a read of a URL path (`split`, `match`,
// `matchAll`, `slice`, `substring`, `substr`, `replace`, `replaceAll`,
// `startsWith`, `endsWith` or `includes` called on a `pathname` binding or
// `.pathname` member, or a regex `exec` or `test` given one) does not sit in
// a function, or under an enclosing function or module, that spells a matter
// route. A matter route is spelled by a string, template or regex literal
// holding `workspaces/` (not the API's `v1/workspaces/`), a bare
// `"workspaces"` segment, or the bare `"/document"` suffix. Route templates
// (`/workspaces/$workspaceId`), object keys and module sources spell no path.
// A route prefix imported from another module, or a path bound to another
// name first, is out of reach. The removed path helpers
// (`getCurrentWorkspaceViewId`, `isWorkspaceDocumentRoutePath`) may not be
// imported or declared again.
//
// Flags:
//   const prefix = `/workspaces/${workspaceId}/`;
//   const viewId = pathname.slice(prefix.length).split("/").at(0);
//   new RegExp(`^/workspaces/${workspaceId}/[^/]+/document`, "u").test(pathname);
//   /^\/workspaces\/[^/]+\/([^/]+)/u.exec(router.state.location.pathname);
//   location.pathname.startsWith("/workspaces/");
//
// Allows:
//   const currentView = getCurrentWorkspaceView(router.state.matches);
//   const name = url.pathname.split("/").at(-1);
//   if (pathname.startsWith("/v1/workspaces/")) return listMatters();

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
const REMOVED_PATH_HELPERS = new Set([
  "getCurrentWorkspaceViewId",
  "isWorkspaceDocumentRoutePath",
]);
// `workspaces/` in a path, a regex (`workspaces\/`) or a template chunk, but
// not behind the API's `v1/`; the bare segment a split path is compared
// against; or the document page's path suffix.
const MATTER_ROUTE_TEXT =
  /(?<!v1\\?\/)workspaces\\?\/|^workspaces$|^\/document$/u;
// A TanStack route template (`/workspaces/$workspaceId`) names a route; it
// parses nothing.
const ROUTE_TEMPLATE_TEXT = /\/\$[A-Za-z_]/u;
const MODULE_SOURCE_PARENTS = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "ImportExpression",
]);
// String methods that read a segment of, or test, the path they are called on.
const PATH_READ_METHODS = new Set([
  "endsWith",
  "includes",
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "startsWith",
  "substr",
  "substring",
]);
// Regex methods that read the path passed to them.
const REGEX_READ_METHODS = new Set(["exec", "test"]);
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

/** Whether `call` reads or tests a URL path. */
const readsPath = (call: AstNode): boolean => {
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === null) {
    return false;
  }
  if (REGEX_READ_METHODS.has(method)) {
    return Array.isArray(call.arguments) && isPathname(call.arguments.at(0));
  }
  return PATH_READ_METHODS.has(method) && isPathname(callee.object);
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
  meta: { name: "no-route-identity-from-path" },
  rules: {
    "no-route-identity-from-path": {
      meta: {
        type: "problem",
        messages: {
          pathRead:
            "Do not read which matter page is on screen off the URL path: the route matches name it. Use useCurrentWorkspaceView() in render, or getCurrentWorkspaceView / getCurrentWorkspaceDocument over router.state.matches (or beforeLoad matches), from @/lib/workspaces/use-workspace-view-params.",
          removedHelper:
            "{{name}} read the matter page from the URL path. Use getCurrentWorkspaceView / getCurrentWorkspaceDocument from @/lib/workspaces/use-workspace-view-params.",
        },
        schema: [],
      },
      createOnce(context) {
        let routeScopes = new Set<AstNode>();
        let pathReads: AstNode[] = [];
        const markRouteText = (node: AstNode) => {
          const text = literalText(node);
          const scope = enclosingScopes(node).at(0);
          if (
            text !== null &&
            scope &&
            MATTER_ROUTE_TEXT.test(text) &&
            !ROUTE_TEMPLATE_TEXT.test(text) &&
            !isNonPathPosition(node)
          ) {
            routeScopes.add(scope);
          }
        };
        const reportRemovedName = (node: unknown) => {
          if (isIdentifier(node) && REMOVED_PATH_HELPERS.has(node.name)) {
            context.report({
              node,
              messageId: "removedHelper",
              data: { name: node.name },
            });
          }
        };
        return {
          before() {
            routeScopes = new Set();
            pathReads = [];
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
            if (isAstNode(node) && readsPath(node)) {
              pathReads.push(node);
            }
          },
          ImportSpecifier(node) {
            const name = getImportedName(node);
            if (name !== null && REMOVED_PATH_HELPERS.has(name)) {
              context.report({
                node,
                messageId: "removedHelper",
                data: { name },
              });
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
            for (const node of pathReads) {
              if (enclosingScopes(node).some(spellsRoute)) {
                context.report({ node, messageId: "pathRead" });
              }
            }
          },
        };
      },
    },
  },
});
