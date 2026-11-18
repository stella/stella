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
//   Today's offenders are listed in `route-pending-component-exceptions.json`;
//   the list only shrinks: a listed file that conforms is reported until its
//   line is deleted.
// - `pending-module-imports` (`*.pending.tsx`): imports are closed: other
//   `.pending` modules, `.logic` modules, type-only imports, and the modules
//   in `route-pending-component-policy.json`. Because the set is closed, the
//   per-file check guarantees the whole pending graph. No dynamic import,
//   no `lazy`, no `useTranslations` (use `PendingText`), no query, navigation
//   or route hooks, except the loose URL reads `useParams({ strict: false })`
//   and `useSearch({ strict: false })` and the named synchronous cache
//   readers in the policy file.
// - `page-module-shell` (`*.page.tsx`): the page imports its sibling
//   `.pending` module, where its shell lives.

import { eslintCompatPlugin } from "@oxlint/plugins";

import exceptionList from "./route-pending-component-exceptions.json" with { type: "json" };
import policy from "./route-pending-component-policy.json" with { type: "json" };
import {
  elementName,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  repoRelativeFilename,
} from "./utils.ts";

const EXCEPTED_FILES: ReadonlySet<string> = new Set(exceptionList);
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

const isCallTo = (value, name) =>
  value?.type === "CallExpression" && isIdentifier(value.callee, name);

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

const stripExtension = (source: string) =>
  source.replace(/\.(?:tsx?|jsx?)$/u, "");

const isTypeOnlyImport = (node) =>
  node.importKind === "type" ||
  (node.specifiers?.length > 0 &&
    node.specifiers.every(
      (specifier) =>
        specifier.type === "ImportSpecifier" && specifier.importKind === "type",
    ));

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

const fileStem = (context, suffix: string) => {
  const name = filenameForContext(context).split("/").at(-1) ?? "";
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
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
      conformingException:
        "This route file now declares its pending view: delete its line from .oxlint-plugins/route-pending-component-exceptions.json.",
    },
    // `census: true` reports every offender, ignoring the exception list,
    // so the list can be regenerated from a full run.
    schema: [
      {
        type: "object",
        properties: { census: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    const findings: Parameters<typeof context.report>[0][] = [];
    const importSources = new Map<string, string>();
    let program: unknown = null;
    let rendersOutlet = false;
    let routeCalls: unknown[] = [];
    return {
      Program(node) {
        findings.length = 0;
        importSources.clear();
        program = node;
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
      "Program:exit"() {
        for (const call of routeCalls) {
          checkRoute(call);
        }
        const options: unknown = context.options[0];
        const census =
          typeof options === "object" &&
          options !== null &&
          Reflect.get(options, "census") === true;
        const excepted =
          !census && EXCEPTED_FILES.has(repoRelativeFilename(context));
        if (!excepted) {
          for (const finding of findings) {
            context.report(finding);
          }
          return;
        }
        if (findings.length === 0 && isAstNode(program)) {
          context.report({ node: program, messageId: "conformingException" });
        }
      },
    };

    function importedFrom(value, suffix: string) {
      if (!isIdentifier(value)) {
        return false;
      }
      const source = importSources.get(value.name);
      return source !== undefined && stripExtension(source).endsWith(suffix);
    }

    function checkRoute(call) {
      const properties = routeProperties(call.arguments[0]);
      for (const key of ["component", "pendingComponent"]) {
        const property = properties.get(key);
        if (
          property !== undefined &&
          isCallTo(property.value, LAZY_ROUTE_COMPONENT)
        ) {
          findings.push({ node: property, messageId: "lazyRouteComponent" });
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
        findings.push({
          node: component,
          messageId: "missingPendingComponent",
        });
        return;
      }
      if (isIdentifier(pending.value, LAYOUT_DELEGATE)) {
        if (!rendersOutlet) {
          findings.push({ node: pending, messageId: "layoutWithoutOutlet" });
        }
        return;
      }
      if (isDefaultPending(pending.value)) {
        findings.push({ node: pending, messageId: "defaultPendingComponent" });
        return;
      }
      const paired =
        importedFrom(component.value, ".page") &&
        importedFrom(pending.value, ".pending") &&
        component.value.name !== pending.value.name;
      if (!paired) {
        findings.push({ node: pending, messageId: "pageModulePair" });
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
    return {
      ImportDeclaration(node) {
        if (
          isTypeOnlyImport(node) ||
          isPendingSafeSource(node.source.value) ||
          importsOnlySafeNames(node)
        ) {
          return;
        }
        context.report({ node, messageId: "closedImport" });
      },
      ImportExpression(node) {
        context.report({ node, messageId: "dynamicImport" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === "Identifier" &&
          LOOSE_URL_HOOKS.has(callee.name) &&
          isLooseCall(node)
        ) {
          return;
        }
        const name =
          callee?.type === "Identifier"
            ? callee.name
            : callee?.type === "MemberExpression"
              ? getPropertyName(callee.property)
              : null;
        if (name !== null && PENDING_BANNED_CALLS.has(name)) {
          context.report({ node, messageId: "bannedCall" });
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
        "A page module renders the shell its sibling `.pending` module exports, so the two phases cannot drift: import it from `./{{stem}}.pending`.",
    },
    schema: [],
  },
  createOnce(context) {
    let importsSibling = false;
    let program: unknown = null;
    return {
      Program(node) {
        importsSibling = false;
        program = node;
      },
      ImportDeclaration(node) {
        const stem = fileStem(context, ".page.tsx");
        if (
          stem !== null &&
          stripExtension(node.source.value).endsWith(`/${stem}.pending`)
        ) {
          importsSibling = true;
        }
      },
      "Program:exit"() {
        const stem = fileStem(context, ".page.tsx");
        if (stem !== null && !importsSibling && isAstNode(program)) {
          context.report({
            node: program,
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
