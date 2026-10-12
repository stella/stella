import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Source-text guards over web modules live in this package so the affected
// filter runs them on every web change; a guard housed elsewhere only runs
// when that other package is touched.
const repoRoot = path.join(import.meta.dir, "../../..");

const readRootFixture = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf-8");

describe("custom oxlint guardrails", () => {
  test("containedHandler helper uses Node, not Element, for containment", () => {
    const helperSource = readRootFixture(
      "packages/ui/src/hooks/use-contained-handler.ts",
    );

    // `Node.contains` accepts any Node; narrowing the target to
    // `Element` previously let Text-node click targets bypass the
    // containment filter.
    expect(helperSource).toContain("instanceof Node");
    expect(helperSource).not.toContain("instanceof Element");
  });

  test("route loader query lint points at route-fresh helpers", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-raw-route-query-client.ts",
    );
    const configSource = readRootFixture("oxlint.config.ts");
    const reactQuerySource = readRootFixture("apps/web/src/lib/react-query.ts");

    expect(pluginSource).toContain("ensureRouteQueryData");
    expect(pluginSource).toContain("ensureRouteInfiniteQueryData");
    expect(pluginSource).toContain("fetchRouteQuery");
    expect(pluginSource).toContain("prefetchRouteQuery");
    expect(pluginSource).toContain("ensureCriticalQueryData");
    expect(pluginSource).toContain("prefetchNonCriticalQuery");
    expect(pluginSource).toContain("route-seeded queries carry");
    expect(pluginSource).toContain("pendingComponent");
    expect(pluginSource).toContain("useQueryClient().getQueryData");
    expect(pluginSource).toContain("abandoned pending renders");
    expect(reactQuerySource).toContain("ensureRouteInfiniteQueryData");
    // Scoped to the helper body: the non-critical prefetch also calls
    // `infiniteQuery`, so a file-wide match would not notice the route-fresh
    // helper drifting off it.
    const routeInfiniteStart = reactQuerySource.indexOf(
      "export const ensureRouteInfiniteQueryData",
    );
    expect(routeInfiniteStart).toBeGreaterThan(-1);
    const routeInfiniteEnd = reactQuerySource.indexOf(
      "\nexport const ",
      routeInfiniteStart + 1,
    );
    const routeInfiniteHelper = reactQuerySource.slice(
      routeInfiniteStart,
      routeInfiniteEnd === -1 ? undefined : routeInfiniteEnd,
    );
    expect(routeInfiniteHelper).toContain(
      "queryClient.infiniteQuery(routeQueryOptions(options))",
    );

    expect(configSource).toContain(
      "./.oxlint-plugins/no-raw-route-query-client.ts",
    );
    expect(configSource).toContain(
      "no-raw-route-query-client/no-raw-route-query-client",
    );
    expect(configSource).toContain(
      ".oxlint-plugins/__fixtures__/no-raw-route-query-client.fixture.tsx",
    );
  });

  test("protected shell chrome queries stay non-critical and route-fresh", () => {
    // The signed-in guard and frame live beside the `_protected` route, which
    // only wires them up.
    const protectedRouteFileSource = readRootFixture(
      "apps/web/src/routes/_protected.tsx",
    );
    const protectedGuardSource = readRootFixture(
      "apps/web/src/routes/-protected-guard.ts",
    );
    const protectedFrameSource = readRootFixture(
      "apps/web/src/routes/-protected-app.tsx",
    );
    const sidebarUserMenuSource = readRootFixture(
      "apps/web/src/components/sidebar-user-menu.tsx",
    );
    const aiConfigQuerySource = readRootFixture(
      "apps/web/src/lib/organization/ai-config-queries.ts",
    );
    const organizationQuerySource = readRootFixture(
      "apps/web/src/lib/organization/queries.ts",
    );
    const workspacesQuerySource = readRootFixture(
      "apps/web/src/lib/workspaces/queries.ts",
    );

    const shellPrefetchStart = protectedGuardSource.indexOf(
      "// Start optional shell data immediately.",
    );
    expect(shellPrefetchStart).toBeGreaterThan(-1);
    expect(protectedGuardSource.slice(shellPrefetchStart)).not.toContain(
      "ensureRouteQueryData",
    );
    expect(protectedGuardSource).toContain("prefetchRouteQuery");
    expect(protectedGuardSource).toContain("aiAvailabilityOptions");
    expect(protectedGuardSource).toContain("roleOptions");
    expect(protectedGuardSource).not.toContain("organizationOptions");

    // The route definition (beforeLoad, loader) must never seed the matter
    // list: route commit cannot wait on it. The rendered shell may subscribe
    // to it, but only as deferred chrome, which dedupes with the sidebar's
    // identical subscription instead of adding a request.
    expect(protectedRouteFileSource).toContain(
      "beforeLoad: loadProtectedContext,",
    );
    expect(protectedRouteFileSource).toContain(
      "loader: prefetchProtectedShell,",
    );
    expect(protectedGuardSource).toContain(
      "export const loadProtectedContext = async",
    );
    expect(protectedGuardSource).not.toContain("workspacesNavigationOptions");
    const navigationListReads =
      protectedFrameSource.match(/workspacesNavigationOptions\(/gu) ?? [];
    const chromeNavigationListReads =
      protectedFrameSource.match(
        /useChromeQuery\(\s*workspacesNavigationOptions\(/gu,
      ) ?? [];
    expect(chromeNavigationListReads).toHaveLength(navigationListReads.length);

    expect(protectedFrameSource).toContain("AIAvailabilityProvider");
    expect(protectedFrameSource).toContain("AppSidebar");
    expect(protectedFrameSource).toContain("ChatMentionProviders");
    expect(sidebarUserMenuSource).not.toContain("organizationOptions");
    expect(sidebarUserMenuSource).toContain("organizationListOptions");
    expect(aiConfigQuerySource).toContain("ROUTE_QUERY_STALE_TIME_MS");
    expect(aiConfigQuerySource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
    expect(organizationQuerySource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
    expect(organizationQuerySource).toContain(
      "membersLimit: BETTER_AUTH_ORGANIZATION_OPTIONS.membershipLimit",
    );
    expect(workspacesQuerySource).toContain("workspacesNavigationOptions");
    expect(workspacesQuerySource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
  });

  test("route-seeded entity queries keep observer freshness", () => {
    const routeSource = readRootFixture(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.route.tsx",
    );
    const entityQuerySource = readRootFixture(
      "apps/web/src/lib/workspaces/queries/entities.ts",
    );
    const entitiesWindowOptionsSource = entityQuerySource.slice(
      entityQuerySource.indexOf("export const entitiesWindowOptions"),
      entityQuerySource.indexOf("export const filesystemEntitiesOptions"),
    );
    const filesystemEntitiesOptionsSource = entityQuerySource.slice(
      entityQuerySource.indexOf("export const filesystemEntitiesOptions"),
      entityQuerySource.indexOf("const kanbanGroupOptions"),
    );

    expect(routeSource).toContain("ensureRouteInfiniteQueryData");
    expect(routeSource).toContain("entitiesWindowOptions");
    expect(routeSource).toContain("ensureRouteQueryData");
    expect(routeSource).toContain("filesystemEntitiesOptions");
    expect(entityQuerySource).toContain("ROUTE_QUERY_STALE_TIME_MS");
    expect(entitiesWindowOptionsSource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
    expect(filesystemEntitiesOptionsSource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
  });

  test("deleted legacy entity route stays deleted and lint-guarded", () => {
    const routesDirectory = path.join(repoRoot, "apps/web/src/routes");
    const oxlintConfig = readRootFixture("oxlint.config.ts");
    const legacyEntityRouteFile =
      /(?:^|\/)_protected\.workspaces(?:\/|\.)\$workspaceId(?:\/|\.)entities_?(?:\/|\.)\$entityId(?:[./]|$)/u;
    const routeSourceFile = /\.[cm]?[jt]sx?$/u;

    const legacyRouteSourceFiles = existsSync(routesDirectory)
      ? readdirSync(routesDirectory, { recursive: true }).filter(
          (entry) =>
            typeof entry === "string" &&
            legacyEntityRouteFile.test(entry) &&
            routeSourceFile.test(entry),
        )
      : [];

    expect(
      [
        "_protected.workspaces/$workspaceId/entities/$entityId.tsx",
        "_protected.workspaces/$workspaceId/entities/$entityId/route.tsx",
        "_protected.workspaces/$workspaceId/entities_.$entityId.tsx",
        "_protected.workspaces.$workspaceId.entities.$entityId.tsx",
        "_protected.workspaces.$workspaceId.entities_.$entityId.tsx",
        "_protected.workspaces.$workspaceId.entities.$entityId.lazy.tsx",
      ].every(
        (candidate) =>
          legacyEntityRouteFile.test(candidate) &&
          routeSourceFile.test(candidate),
      ),
    ).toBe(true);
    expect(legacyRouteSourceFiles).toEqual([]);
    expect(oxlintConfig).toContain(`
      files: ["apps/web/src/**/*.{ts,tsx}"],
      rules: {
        "no-legacy-entity-route/no-legacy-entity-route": "error",
      },
    `);
  });

  test("tools route keeps heavy catalogue UI behind Suspense", () => {
    const toolsRouteSource = readRootFixture(
      "apps/web/src/routes/knowledge/tools.tsx",
    );
    const memberToolsSource = readRootFixture(
      "apps/web/src/routes/knowledge/-member/member-tools-page.tsx",
    );
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-static-catalogue-route-import.ts",
    );
    const configSource = readRootFixture("oxlint.config.ts");

    expect(toolsRouteSource).toContain("const LazyMemberToolsPage = lazy");
    expect(memberToolsSource).toContain("const LazyCatalogueBrowser = lazy");
    expect(memberToolsSource).toContain("catalogue/catalogue-browser");
    expect(memberToolsSource).toContain(
      "return { default: module.CatalogueBrowserWithRouteData };",
    );
    expect(memberToolsSource).toContain("useSuspenseQueries");
    expect(memberToolsSource).toContain("canManageCustomTools");
    expect(memberToolsSource).toContain("practiceJurisdictions");
    expect(memberToolsSource).not.toContain("import { CatalogueBrowser");
    expect(toolsRouteSource).toContain("const LazyToolDetailView = lazy");
    expect(toolsRouteSource).toContain("const LazyToolDetailRailIcon = lazy");
    expect(toolsRouteSource).not.toContain("import { CatalogueBrowser");
    expect(toolsRouteSource).not.toContain("ToolDetailView,");
    expect(toolsRouteSource).not.toContain("ToolDetailRailIcon,");

    expect(pluginSource).toContain("CATALOGUE_BROWSER_MODULE");
    expect(pluginSource).toContain('node.importKind === "type"');
    expect(pluginSource).toContain("staticCatalogueImport");
    expect(configSource).toContain(
      "./.oxlint-plugins/no-static-catalogue-route-import.ts",
    );
    expect(configSource).toContain(
      "no-static-catalogue-route-import/no-static-catalogue-route-import",
    );
    expect(configSource).toContain("apps/web/src/routes/knowledge/tools.tsx");
    expect(configSource).toContain(
      "apps/web/src/routes/knowledge/-member/member-tools-page.tsx",
    );
  });

  test("devtools shell lazy-loads TanStack panels", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/restricted-import.ts",
    );
    const configSource = readRootFixture("oxlint.config.ts");
    const devRootSource = readRootFixture(
      "apps/web/src/components/dev-root.tsx",
    );
    const tanstackDevtoolsRootSource = readRootFixture(
      "apps/web/src/components/tanstack-devtools-root.tsx",
    );
    const tableLayoutSource = readRootFixture(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-layout.tsx",
    );
    const tableDevtoolsGateSource = readRootFixture(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools-gate.tsx",
    );

    expect(devRootSource).toContain(
      'import("@/components/tanstack-devtools-root")',
    );
    expect(devRootSource).not.toContain("@tanstack/react-table-devtools");
    expect(devRootSource).not.toContain("@tanstack/react-devtools");
    expect(tanstackDevtoolsRootSource).toContain(
      "@tanstack/react-table-devtools",
    );
    expect(tanstackDevtoolsRootSource).toContain("tableDevtoolsPlugin()");
    expect(tableLayoutSource).toContain("TableDevtoolsGate");
    expect(tableLayoutSource).toContain("table-devtools-gate");
    expect(tableLayoutSource).not.toContain('table-devtools"');
    expect(tableDevtoolsGateSource).toContain("state.tanstackDevtools");
    expect(tableDevtoolsGateSource).toContain("table-devtools");

    expect(pluginSource).toContain('"no-static-devtools-import": [');
    expect(pluginSource).toContain("@tanstack/react-table-devtools");
    expect(pluginSource).toContain("dynamicImports: DYNAMIC_IMPORTS.allowed");
    expect(pluginSource).toContain("staticDevtoolsPackage");
    expect(pluginSource).toContain("staticDevtoolsModule");
    expect(configSource).toContain(
      "./.oxlint-plugins/no-static-devtools-import.ts",
    );
    expect(configSource).toContain(
      "no-static-devtools-import/no-static-devtools-import",
    );
    expect(configSource).toContain(
      ".oxlint-plugins/__fixtures__/no-static-devtools-import.fixture.tsx",
    );
  });

  test("workspace table measures scroll metrics after mount", () => {
    const tableSource = readRootFixture(
      "apps/web/src/components/workspaces/table/workspace-table/workspace-table.tsx",
    );

    expect(tableSource).toContain("useExternalSyncEffect(() => {");
    expect(tableSource).toContain("const element = tableWrapperRef.current");
    expect(tableSource).toContain("new ResizeObserver(updateMetrics)");
    expect(tableSource).toContain("ref={tableWrapperRef}");
    expect(tableSource).not.toContain("tableWrapperObserverRef");
    expect(tableSource).not.toContain("composeRefs(tableWrapperRef");
  });
});
