// A page route's loading view is its own page in a pending phase.
//
// Contract: apps/web/src/routes/-route-pending-view.tsx. A converted route
// has two sibling modules, `x.pending.tsx` (the page shell, and `XPending`:
// the shell with the paired pending pieces in its data slots) and
// `x.page.tsx` (`XPage`: the same shell with the real content). The route
// file imports both and defines neither, so the bundler splits the page into
// its own chunk while the pending half stays small in the entry chunk.
//
// Rules:
// - `route-pending-component` (route files): on a `createFileRoute(...)({})`
//   with a `component`, `component` and `pendingComponent` are distinct
//   identifiers imported from a `.page` and a `.pending` module. A layout
//   (its file renders `<Outlet />`) delegates instead, with
//   `pendingComponent: LeafPendingView`; a route that only redirects uses
//   `component: redirectRouteComponent({ to })`, which shows its target's
//   pending view. `DefaultPendingComponent` and `lazyRouteComponent` (which
//   hides the page chunk from the manifest's preloads) are banned there.
//   The pending view a route names is a frame view: its module marks it
//   with `framePendingView`.
// - `pending-module-imports` (every `*.pending.tsx`, which the cold-load
//   frame may draw before any provider mounts): imports are closed: other
//   `.pending` modules, `.logic` modules, type-only imports, and the modules
//   in `route-pending-component-policy.json`. No dynamic import,
//   no `lazy`, no `useTranslations` (use `PendingText`), no query, navigation
//   or route hooks, except the loose URL reads `useParams({ strict: false })`
//   and `useSearch({ strict: false })` and the named synchronous cache
//   readers in the policy file.
// - `page-module-shell` (`*.page.tsx` with a sibling `.pending` module): the
//   page imports and renders the shell that sibling exports.

import { eslintCompatPlugin } from "@oxlint/plugins";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import policy from "./route-pending-component-policy.json" with { type: "json" };
import {
  elementName,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isCallTo,
  isIdentifier,
} from "./utils.ts";

const PENDING_SAFE_MODULES: ReadonlySet<string> = new Set(
  policy.pendingSafeModules,
);
const PENDING_SAFE_NAMED_IMPORTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map(
  Object.entries(policy.pendingSafeNamedImports).map(([source, names]) => [
    source,
    new Set(names),
  ]),
);
const SYNC_CACHE_READERS: ReadonlySet<string> = new Set(
  policy.syncCacheReaders,
);

// URL reads a pending half may make: the router context is there at every
// pending level, but only a loose read (`strict: false`), since the pending
// match is not always the one the hook would bind to.
const LOOSE_URL_HOOKS: ReadonlySet<string> = new Set([
  "useParams",
  "useSearch",
]);

const isLooseCall = (node) => {
  const [options] = node.arguments ?? [];
  return (
    options?.type === "ObjectExpression" &&
    options.properties.some(
      (property) =>
        property?.type === "Property" &&
        getPropertyName(property.key) === "strict" &&
        property.value?.type === "Literal" &&
        property.value.value === false,
    )
  );
};

const DEFAULT_PENDING = "DefaultPendingComponent";
const REDIRECT_MARKER = "redirectRouteComponent";
const LAYOUT_DELEGATE = "LeafPendingView";
const LAZY_ROUTE_COMPONENT = "lazyRouteComponent";
// Marks a pending view the cold-load frame may draw before the providers.
const FRAME_PENDING_VIEW = "framePendingView";

// Hooks a context-free pending half may not call: it renders before any
// provider, and the closed imports keep most of them out already.
const PENDING_BANNED_CALLS: ReadonlySet<string> = new Set([
  "lazy",
  "useTranslations",
  "useFormatter",
  "useQuery",
  "useQueries",
  "useInfiniteQuery",
  "useSuspenseQuery",
  "useSuspenseInfiniteQuery",
  "useQueryClient",
  "useNavigate",
  "useRouter",
  "useRouterState",
  "useRouteContext",
  "useLoaderData",
  "useMatch",
  "useParams",
  "useSearch",
]);

const isRouteOptionsCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee?.type === "CallExpression" &&
  isIdentifier(node.callee.callee, "createFileRoute") &&
  node.arguments?.[0]?.type === "ObjectExpression";

const routeProperties = (options) => {
  const properties = new Map();
  for (const property of options.properties ?? []) {
    if (property?.type !== "Property") {
      continue;
    }
    const name = getPropertyName(property.key);
    if (name !== null) {
      properties.set(name, property);
    }
  }
  return properties;
};

// The element a function renders when its whole body is one JSX element.
const renderedElement = (value) => {
  if (
    value?.type !== "ArrowFunctionExpression" &&
    value?.type !== "FunctionExpression"
  ) {
    return null;
  }
  const body = value.body;
  if (body?.type === "JSXElement") {
    return body;
  }
  if (body?.type === "BlockStatement" && body.body?.length === 1) {
    const [statement] = body.body;
    return statement?.type === "ReturnStatement" &&
      statement.argument?.type === "JSXElement"
      ? statement.argument
      : null;
  }
  return null;
};

const isDefaultPending = (value) =>
  isIdentifier(value, DEFAULT_PENDING) ||
  elementName(renderedElement(value)) === DEFAULT_PENDING;

// A fixture copy of a module (`x.pending.fixture.tsx`) stands for the module.
const stripExtension = (source: string) =>
  source.replace(/\.(?:tsx?|jsx?)$/u, "").replace(/\.fixture$/u, "");

// An import or re-export erased at build time: `import type`, `export type`,
// or one whose every specifier is marked `type`.
const isTypeOnlyImport = (node) =>
  node.importKind === "type" ||
  node.exportKind === "type" ||
  (node.specifiers?.length > 0 &&
    node.specifiers.every(
      (specifier) =>
        (specifier.type === "ImportSpecifier" &&
          specifier.importKind === "type") ||
        (specifier.type === "ExportSpecifier" &&
          specifier.exportKind === "type"),
    ));

const WEB_SOURCE_ROOT = "apps/web/src/";

// Whether the page at `filename` has a `.pending` sibling: a route whose page
// has no loading view of its own yet is the route rule's finding, not this.
const hasSiblingPending = (filename: string, stem: string): boolean =>
  [".pending.tsx", ".pending.fixture.tsx"].some((extension) =>
    existsSync(path.join(path.dirname(filename), `${stem}${extension}`)),
  );

// Whether `source` names the `.pending` module beside the page at
// `filename`: `./x.pending`, or the same file through the `@/` alias. A
// path into another directory with the same file name is another page's.
const isSiblingPending = (
  filename: string,
  source: string,
  stem: string,
): boolean => {
  const bare = stripExtension(source);
  const sibling = `${stem}.pending`;
  if (bare.startsWith(".")) {
    return path.posix.normalize(bare) === sibling;
  }
  const rootAt = filename.lastIndexOf(`/${WEB_SOURCE_ROOT}`);
  if (!bare.startsWith("@/") || rootAt === -1) {
    return false;
  }
  const directory = path.posix.dirname(
    filename.slice(rootAt + WEB_SOURCE_ROOT.length + 1),
  );
  return path.posix.join(directory, sibling) === bare.slice("@/".length);
};

const isPendingSafeSource = (source: string) => {
  const bare = stripExtension(source);
  return (
    bare.endsWith(".pending") ||
    bare.endsWith(".logic") ||
    PENDING_SAFE_MODULES.has(source)
  );
};

// Named imports the policy allows one by one: a module's pending-safe exports
// (the router's loose URL hooks) and the synchronous cache readers.
const importsOnlySafeNames = (node) => {
  const specifiers = node.specifiers ?? [];
  const safeHere = PENDING_SAFE_NAMED_IMPORTS.get(node.source.value);
  return (
    specifiers.length > 0 &&
    specifiers.every((specifier) => {
      if (specifier.type !== "ImportSpecifier") {
        return false;
      }
      if (specifier.importKind === "type") {
        return true;
      }
      const name = getPropertyName(specifier.imported);
      return (
        name !== null &&
        (SYNC_CACHE_READERS.has(name) || safeHere?.has(name) === true)
      );
    })
  );
};

// The file a route's `.pending` import names, or null when it names no
// module this rule can read (a package, or a file that is not there).
const pendingModuleFile = (
  routeFilename: string,
  source: string,
): string | null => {
  const bare = source.replace(/\.(?:tsx?|jsx?)$/u, "");
  let base: string | null = null;
  if (bare.startsWith(".")) {
    base = path.join(path.dirname(routeFilename), bare);
  } else if (bare.startsWith("@/")) {
    const rootAt = routeFilename.lastIndexOf(`/${WEB_SOURCE_ROOT}`);
    base =
      rootAt === -1
        ? null
        : path.join(
            routeFilename.slice(0, rootAt + WEB_SOURCE_ROOT.length + 1),
            bare.slice("@/".length),
          );
  }
  if (base === null) {
    return null;
  }
  return (
    [".tsx", ".fixture.tsx"]
      .map((extension) => `${base}${extension}`)
      .find((file) => existsSync(file)) ?? null
  );
};

// Whether a module's source marks a view for the frame.
const marksFrameView = (file: string): boolean =>
  readFileSync(file, "utf-8").includes(`${FRAME_PENDING_VIEW}(`);

// The page a `x.page.tsx` module (or its fixture copy) is named for.
const pageStem = (context): string | null => {
  const name = filenameForContext(context).split("/").at(-1) ?? "";
  return (
    /^(?<stem>.+)\.page(?:\.fixture)?\.tsx$/u.exec(name)?.groups?.stem ?? null
  );
};

const routePendingComponent = {
  meta: {
    type: "problem" as const,
    messages: {
      missingPendingComponent:
        "A page route declares `pendingComponent`: its page in a pending phase, from a sibling `.pending` module (see apps/web/src/routes/-route-pending-view.tsx). A layout uses `pendingComponent: LeafPendingView`; a route that only redirects uses `component: redirectRouteComponent({ to })`.",
      pageModulePair:
        "`component` and `pendingComponent` are distinct identifiers imported from the page's `.page` and `.pending` modules; the route file defines no components.",
      defaultPendingComponent:
        "`DefaultPendingComponent` is the frame's last resort, not a page's loading view. Render the page's shell in its pending phase from its `.pending` module.",
      lazyRouteComponent:
        "No `lazyRouteComponent` in route options: it hides the page chunk from the manifest, so the page is fetched one hop late. Import the page from its `.page` module; the bundler splits it.",
      layoutWithoutOutlet:
        "Only a layout (a route file rendering `<Outlet />`) delegates its pending view to its page with `LeafPendingView`.",
      unmarkedPendingView:
        "A route's pending view is a frame view, drawn on a cold load before the providers mount: mark it with `framePendingView` in its `.pending` module.",
    },
    schema: [],
  },
  createOnce(context) {
    const importSources = new Map<string, string>();
    let rendersOutlet = false;
    let routeCalls: unknown[] = [];
    return {
      Program() {
        importSources.clear();
        rendersOutlet = false;
        routeCalls = [];
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers ?? []) {
          importSources.set(specifier.local.name, node.source.value);
        }
      },
      JSXOpeningElement(node) {
        if (
          node.name?.type === "JSXIdentifier" &&
          node.name.name === "Outlet"
        ) {
          rendersOutlet = true;
        }
      },
      CallExpression(node) {
        if (isRouteOptionsCall(node)) {
          routeCalls.push(node);
        }
      },
      // Checked at the end: a layout's `<Outlet />` may follow its route.
      "Program:exit"() {
        for (const call of routeCalls) {
          checkRoute(call);
        }
      },
    };

    // The module stem an identifier was imported from with `suffix`
    // (`./x.page` gives `./x`), or null.
    function importedStem(value, suffix: string): string | null {
      if (!isIdentifier(value)) {
        return null;
      }
      const source = importSources.get(value.name);
      if (source === undefined) {
        return null;
      }
      const bare = stripExtension(source);
      return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : null;
    }

    function checkRoute(call) {
      const properties = routeProperties(call.arguments[0]);
      for (const key of ["component", "pendingComponent"]) {
        const property = properties.get(key);
        if (
          property !== undefined &&
          isCallTo(property.value, LAZY_ROUTE_COMPONENT)
        ) {
          context.report({ node: property, messageId: "lazyRouteComponent" });
        }
      }
      const component = properties.get("component");
      if (
        component === undefined ||
        isCallTo(component.value, REDIRECT_MARKER)
      ) {
        return;
      }
      const pending = properties.get("pendingComponent");
      if (pending === undefined) {
        context.report({
          node: component,
          messageId: "missingPendingComponent",
        });
        return;
      }
      if (isIdentifier(pending.value, LAYOUT_DELEGATE)) {
        if (!rendersOutlet) {
          context.report({ node: pending, messageId: "layoutWithoutOutlet" });
        }
        return;
      }
      if (isDefaultPending(pending.value)) {
        context.report({ node: pending, messageId: "defaultPendingComponent" });
        return;
      }
      // The page and its pending view come from one pair of siblings, so a
      // route never waits on another page's shell.
      const pageStemOfRoute = importedStem(component.value, ".page");
      const paired =
        pageStemOfRoute !== null &&
        importedStem(pending.value, ".pending") === pageStemOfRoute &&
        component.value.name !== pending.value.name;
      if (!paired) {
        context.report({ node: pending, messageId: "pageModulePair" });
        return;
      }
      // The pending view must be one the frame can draw.
      const source = importSources.get(pending.value.name);
      const file =
        source === undefined
          ? null
          : pendingModuleFile(filenameForContext(context), source);
      if (file !== null && !marksFrameView(file)) {
        context.report({ node: pending, messageId: "unmarkedPendingView" });
      }
    }
  },
};

const pendingModuleImports = {
  meta: {
    type: "problem" as const,
    messages: {
      closedImport:
        "A pending half imports only `.pending` and `.logic` modules, type-only imports and the pending-safe modules in .oxlint-plugins/route-pending-component-policy.json: it ships in the entry chunk and renders before any provider.",
      dynamicImport:
        "A pending half loads nothing lazily: it is the view shown while the page loads.",
      bannedCall:
        "A pending half is context-free: no translations hook (use `PendingText`), no query, router or route hook, no `lazy`.",
    },
    schema: [],
  },
  createOnce(context) {
    // Local names bound to the router's URL hooks, aliases included.
    const urlHookLocals = new Set<string>();
    const report = (node, messageId: string) => {
      context.report({ node, messageId });
    };
    const checkSource = (node) => {
      if (
        isTypeOnlyImport(node) ||
        isPendingSafeSource(node.source.value) ||
        importsOnlySafeNames(node)
      ) {
        return;
      }
      report(node, "closedImport");
    };
    return {
      Program() {
        urlHookLocals.clear();
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers ?? []) {
          const imported =
            specifier.type === "ImportSpecifier"
              ? getPropertyName(specifier.imported)
              : null;
          if (imported !== null && LOOSE_URL_HOOKS.has(imported)) {
            urlHookLocals.add(specifier.local.name);
          }
        }
        checkSource(node);
      },
      // A re-export is a runtime dependency of the pending half too.
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSource(node);
        }
      },
      ExportAllDeclaration(node) {
        checkSource(node);
      },
      ImportExpression(node) {
        report(node, "dynamicImport");
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type === "Identifier" && urlHookLocals.has(callee.name)) {
          if (!isLooseCall(node)) {
            report(node, "bannedCall");
          }
          return;
        }
        const name =
          callee?.type === "Identifier"
            ? callee.name
            : callee?.type === "MemberExpression"
              ? getPropertyName(callee.property)
              : null;
        if (name !== null && PENDING_BANNED_CALLS.has(name)) {
          report(node, "bannedCall");
        }
      },
    };
  },
};

const pageModuleShell = {
  meta: {
    type: "problem" as const,
    messages: {
      missingShellImport:
        "A page module renders the shell its sibling `.pending` module exports, so the two phases cannot drift: import it from `./{{stem}}.pending` and render it.",
    },
    schema: [],
  },
  createOnce(context) {
    // Value bindings imported from the sibling pending module, and whether
    // the page renders one of them as an element.
    const siblingLocals = new Set<string>();
    let rendersSibling = false;
    let firstStatement: unknown = null;
    return {
      Program(node) {
        siblingLocals.clear();
        rendersSibling = false;
        // Reported on the module's first statement, where a reader looks for
        // its imports.
        firstStatement = node.body?.[0] ?? node;
      },
      ImportDeclaration(node) {
        const stem = pageStem(context);
        if (
          stem === null ||
          node.importKind === "type" ||
          !isSiblingPending(
            filenameForContext(context),
            node.source.value,
            stem,
          )
        ) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (specifier.importKind !== "type") {
            siblingLocals.add(specifier.local.name);
          }
        }
      },
      JSXOpeningElement(node) {
        if (
          node.name?.type === "JSXIdentifier" &&
          siblingLocals.has(node.name.name)
        ) {
          rendersSibling = true;
        }
      },
      "Program:exit"() {
        const stem = pageStem(context);
        if (
          stem !== null &&
          !rendersSibling &&
          hasSiblingPending(filenameForContext(context), stem) &&
          isAstNode(firstStatement)
        ) {
          context.report({
            node: firstStatement,
            messageId: "missingShellImport",
            data: { stem },
          });
        }
      },
    };
  },
};

export default eslintCompatPlugin({
  meta: { name: "route-pending-component" },
  rules: {
    "route-pending-component": routePendingComponent,
    "pending-module-imports": pendingModuleImports,
    "page-module-shell": pageModuleShell,
  },
});
