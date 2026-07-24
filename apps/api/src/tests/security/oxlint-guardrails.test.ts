import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const readRootFixture = (relativePath: string) =>
  readFileSync(
    path.join(import.meta.dir, "../../../../..", relativePath),
    "utf-8",
  );

describe("custom oxlint guardrails", () => {
  test("process.env rule treats only static computed keys as known names", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/forbid-process-env-outside-env-ts.ts",
    );

    expect(pluginSource).toContain("const staticMemberPropertyName");
    expect(pluginSource).toContain("isStringLiteral(node.property)");
    expect(pluginSource).toContain('return "process.env[...]"');
  });

  test("JSX literal rule is not scoped to files using translation markers", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-untranslated-jsx-literal.ts",
    );
    const oxlintConfig = readRootFixture("oxlint.config.ts");

    expect(pluginSource).toContain("options.requireTranslationUsage === true");
    expect(pluginSource).toContain("sourceText.includes(marker)");
    expect(pluginSource).toContain("useTranslations");
    expect(pluginSource).toContain("TranslationKey");
    expect(oxlintConfig).toContain(
      '"no-untranslated-jsx-literal/no-untranslated-jsx-literal": [',
    );
    expect(oxlintConfig).not.toContain("requireTranslationUsage: true");
  });

  test("require-contained-handler excludes onBlur and resolves non-identifier refs", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/require-contained-handler.ts",
    );

    // `onBlur` would silently mis-fire because blur's target is the
    // element losing focus, not the new destination — must stay out
    // of the watched set.
    expect(pluginSource).not.toContain('"onBlur"');
    expect(pluginSource).toContain('"onMouseDown"');
    expect(pluginSource).toContain('"onFocus"');

    // Non-identifier ref expressions (MemberExpression, callback refs)
    // must still enforce the rule rather than silently skipping the
    // element — see the `findRefDisplayName` fallback branches.
    expect(pluginSource).toContain("memberExpressionPath");
    expect(pluginSource).toContain('return "ref"');

    // Void / leaf form elements cannot have a React subtree, so the
    // portal scenario cannot apply. They are excluded by name so a
    // `<input ref={…} onMouseDown={…} />` autofocus pattern is left
    // alone instead of acquiring a redundant wrap.
    expect(pluginSource).toContain("LEAF_ELEMENTS");
    expect(pluginSource).toContain('"input"');
    expect(pluginSource).toContain('"textarea"');
  });

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

  test("prompt boundary cast rule protects chat prompt brands", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-prompt-boundary-casts.ts",
    );

    expect(pluginSource).toContain("ChatCacheStablePrefix");
    expect(pluginSource).toContain("ChatSafePrompt");
    expect(pluginSource).toContain("ChatUntrustedPromptSuffix");
    expect(pluginSource).toContain("apps/api/src/handlers/chat/chat-prompt.ts");
    expect(pluginSource).toContain("TSUnionType");
    expect(pluginSource).toContain("TSIntersectionType");
    expect(pluginSource).toContain("TSArrayType");
    expect(pluginSource).toContain("TSTupleType");
    expect(pluginSource).toContain("TSNamedTupleMember");
    expect(pluginSource).toContain("elementType");
    expect(pluginSource).toContain("TSIndexedAccessType");
    expect(pluginSource).toContain("TSLiteralType");
    expect(pluginSource).toContain("TSNumberKeyword");
    expect(pluginSource).toContain("Number.isInteger");
    expect(pluginSource).toContain("ReadonlyArray");
    expect(pluginSource).toContain("getPropertyName");
    expect(pluginSource).toContain("objectType");
    expect(pluginSource).toContain("indexType");
    expect(pluginSource).toContain("TSConditionalType");
    expect(pluginSource).toContain("conditionalExtendsResult");
    expect(pluginSource).toContain("trueType");
    expect(pluginSource).toContain("falseType");
    expect(pluginSource).toContain("TSMappedType");
    expect(pluginSource).toContain("TSTypeLiteral");
    expect(pluginSource).toContain("TSInterfaceDeclaration");
    expect(pluginSource).toContain("TSInterfaceBody");
    expect(pluginSource).toContain("TSFunctionType");
    expect(pluginSource).toContain("TSConstructorType");
    expect(pluginSource).toContain("TSMethodSignature");
    expect(pluginSource).toContain("TSCallSignatureDeclaration");
    expect(pluginSource).toContain("TSConstructSignatureDeclaration");
    expect(pluginSource).toContain("TSIndexSignature");
    expect(pluginSource).toContain("returnType");
    expect(pluginSource).toContain("params");
    expect(pluginSource).toContain("TSParenthesizedType");
    expect(pluginSource).toContain("TSTypeOperator");
    expect(pluginSource).toContain("ImportDeclaration");
    expect(pluginSource).toContain("TSTypeAliasDeclaration");
    expect(pluginSource).toContain("namedTypeAnnotations");
    expect(pluginSource).toContain("typeArgumentsByName");
    expect(pluginSource).toContain("typeParameters");
    expect(pluginSource).toContain("Program:exit");
    expect(pluginSource).toContain("TSImportType");
    expect(pluginSource).toContain("typeArguments");
    expect(pluginSource).toContain("TSTypeAssertion");
  });

  test("public law web modules cannot import protected route code", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "apps/web/src/features/case-law/**/*.{ts,tsx}",
    );
    expect(configSource).toContain("@/routes/_protected.*/**");
    expect(configSource).toContain(
      "Public law routes and shared case-law modules must not import protected route code.",
    );
  });

  test("public API route files cannot import authenticated route capabilities", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/api/src/handlers/**/public-routes.ts");
    expect(configSource).toContain(
      'importNames: ["createSafeHandler", "createSafeRootHandler"]',
    );
    expect(configSource).toContain('name: "@/api/lib/auth"');
    expect(configSource).toContain('name: "@/api/db/root"');
    expect(configSource).toContain(
      "Public route files must use createSafePublicHandler",
    );
  });

  test("public case-law data files cannot query private tables", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/public-case-law-db-boundary.ts",
    );

    expect(configSource).toContain(
      "public-case-law-db-boundary/public-case-law-db-boundary",
    );
    expect(configSource).toContain(
      "apps/api/src/handlers/case-law/decisions/get.ts",
    );
    expect(configSource).toContain(
      "apps/api/src/lib/case-law-public-read-db.ts",
    );
    expect(pluginSource).toContain("privateCaseLawImport");
    expect(pluginSource).toContain("privateTxQuery");
    expect(pluginSource).toContain("privateSqlText");
    expect(pluginSource).toContain("isCaseLawName");
    expect(pluginSource).toContain("tx.query");
    expect(pluginSource).toContain("workspace|workspaces");
    expect(pluginSource).toContain("organization|organizations");
    expect(pluginSource).toContain("matter|matters");
  });

  test("public law route SEO must use the central helper", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-raw-public-law-seo.ts",
    );

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "no-raw-public-law-seo/no-raw-public-law-seo",
    );
    expect(pluginSource).toContain("createPublicLawHead");
    expect(pluginSource).toContain('value === "canonical"');
    expect(pluginSource).toContain('value === "robots"');
    expect(pluginSource).toContain('value.startsWith("og:")');
    expect(pluginSource).toContain('value.startsWith("twitter:")');
  });

  test("public law route files cannot import the Eden API client directly", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain('name: "@/lib/api"');
    expect(configSource).toContain('importNames: ["api"]');
    expect(configSource).toContain(
      "Public law route files must use approved public case-law query modules",
    );
  });

  test("public law modules cannot reference browser globals directly", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-public-law-browser-globals.ts",
    );

    expect(configSource).toContain("apps/web/src/routes/law/**/*.{ts,tsx}");
    expect(configSource).toContain(
      "apps/web/src/features/case-law/**/*.{ts,tsx}",
    );
    expect(configSource).toContain(
      "no-public-law-browser-globals/no-public-law-browser-globals",
    );
    expect(pluginSource).toContain("Public law modules must be SSR-safe");
    expect(pluginSource).toContain('"window"');
    expect(pluginSource).toContain('"document"');
    expect(pluginSource).toContain('"localStorage"');
    expect(pluginSource).toContain('"sessionStorage"');
    expect(pluginSource).toContain('"matchMedia"');
  });

  test("matter links must declare their listing or reference affordance", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/require-matter-affordance.ts",
    );

    expect(configSource).toContain(
      "require-matter-affordance/require-matter-affordance",
    );
    expect(pluginSource).toContain("/workspaces/$workspaceId");
    expect(pluginSource).toContain("MatterContextMenu");
    expect(pluginSource).toContain("MatterRefLink");
    expect(pluginSource).toContain("Navigate");
  });

  test("workspace field value surfaces must use the shared renderer", () => {
    const configSource = readRootFixture("oxlint.config.ts");
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-workspace-field-value-drift.ts",
    );

    expect(configSource).toContain(
      "./.oxlint-plugins/no-workspace-field-value-drift.ts",
    );
    expect(configSource).toContain(
      "no-workspace-field-value-drift/no-workspace-field-value-drift",
    );
    expect(configSource).toContain(
      "no-workspace-field-value-drift/no-raw-field-value-bidi-text",
    );
    expect(configSource).toContain(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/cell-result.tsx",
    );
    expect(configSource).toContain(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table-column.tsx",
    );
    expect(configSource).toContain(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card.tsx",
    );
    expect(configSource).toContain(
      "apps/web/src/components/inspector/entity-metadata-panel.tsx",
    );
    expect(pluginSource).toContain("DISPLAY_FIELD_TYPES");
    expect(pluginSource).toContain('"single-select"');
    expect(pluginSource).toContain("isFieldContentTypeAccess");
    expect(pluginSource).toContain("<FieldValue /> or <EditableField />");
    expect(pluginSource).toContain("BIDI_TEXT_COMPONENTS");
    expect(pluginSource).toContain("noRawFieldValueBidiText");
  });

  test("public SEO endpoints cannot import auth or protected code", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("apps/web/src/routes/robots[.]txt.ts");
    expect(configSource).toContain("apps/web/src/routes/sitemap[.]xml.ts");
    expect(configSource).toContain(
      "apps/web/src/routes/sitemaps/**/*.{ts,tsx}",
    );
    expect(configSource).toContain("apps/web/src/lib/public-law-sitemap.ts");
    expect(configSource).toContain('name: "@/routes/-auth-context"');
    expect(configSource).toContain('name: "@/lib/auth"');
    expect(configSource).toContain(
      "Public SEO endpoints must not import protected route code.",
    );
    expect(configSource).toContain(
      "Public SEO endpoints must use the public case-law API response",
    );
  });

  test("no-raw-use-effect tracks the react import and points at the convention", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-raw-use-effect.ts",
    );

    // Must resolve `useEffect` through the react import (named, aliased,
    // default, and namespace) rather than matching the bare identifier —
    // otherwise an unrelated local `useEffect` would false-positive.
    expect(pluginSource).toContain('const REACT_MODULE = "react"');
    expect(pluginSource).toContain(
      'getImportedName(specifier) === "useEffect"',
    );
    expect(pluginSource).toContain(
      'specifier.type === "ImportDefaultSpecifier"',
    );
    expect(pluginSource).toContain(
      'specifier.type === "ImportNamespaceSpecifier"',
    );

    // allowedFiles lets the sanctioned wrapper module call useEffect directly.
    expect(pluginSource).toContain("allowedFiles");

    // A failing call must point the reader/agent at the source of truth.
    expect(pluginSource).toContain("/conventions-use-effect");
  });

  test("no-raw-use-effect is enabled for apps/web with the wrapper allowlisted", () => {
    const configSource = readRootFixture("oxlint.config.ts");

    expect(configSource).toContain("./.oxlint-plugins/no-raw-use-effect.ts");
    expect(configSource).toContain("no-raw-use-effect/no-raw-use-effect");
    expect(configSource).toContain(
      'allowedFiles: ["apps/web/src/hooks/use-effect.ts"]',
    );
    // The regression fixture is enabled explicitly because the rule is scoped
    // to apps/web/src, which the fixtures dir is not.
    expect(configSource).toContain(
      ".oxlint-plugins/__fixtures__/no-raw-use-effect.fixture.tsx",
    );
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
    expect(reactQuerySource).toContain("fetchInfiniteQuery");

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
    const authSource = readRootFixture("apps/api/src/lib/auth.ts");
    const limitsSource = readRootFixture("apps/api/src/lib/limits.ts");
    const organizationConstsSource = readRootFixture(
      "apps/web/src/routes/_protected.organization/-consts.ts",
    );
    const protectedRouteSource = readRootFixture(
      "apps/web/src/routes/_protected.tsx",
    );
    const sidebarUserMenuSource = readRootFixture(
      "apps/web/src/components/sidebar-user-menu.tsx",
    );
    const aiConfigQuerySource = readRootFixture(
      "apps/web/src/routes/_protected.organization/-ai-config-queries.ts",
    );
    const organizationQuerySource = readRootFixture(
      "apps/web/src/routes/_protected.organization/-queries.ts",
    );
    const workspacesQuerySource = readRootFixture(
      "apps/web/src/routes/_protected.workspaces/-queries.ts",
    );

    expect(protectedRouteSource).not.toContain("ensureRouteQueryData");
    expect(protectedRouteSource).toContain("prefetchRouteQuery");
    expect(protectedRouteSource).toContain("aiAvailabilityOptions");
    expect(protectedRouteSource).toContain("roleOptions");
    expect(protectedRouteSource).not.toContain("organizationOptions");
    expect(protectedRouteSource).not.toContain("workspacesNavigationOptions");
    expect(protectedRouteSource).toContain("AIAvailabilityProvider");
    expect(protectedRouteSource).toContain("AppSidebar");
    expect(protectedRouteSource).toContain("ChatMentionProviders");
    expect(sidebarUserMenuSource).not.toContain("organizationOptions");
    expect(sidebarUserMenuSource).toContain("organizationListOptions");
    expect(aiConfigQuerySource).toContain("ROUTE_QUERY_STALE_TIME_MS");
    expect(aiConfigQuerySource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
    expect(organizationQuerySource).toContain(
      "staleTime: ROUTE_QUERY_STALE_TIME_MS",
    );
    expect(limitsSource).toContain("organizationMembersCount: 500");
    expect(authSource).toContain(
      "membershipLimit: LIMITS.organizationMembersCount",
    );
    expect(organizationConstsSource).toContain(
      "ORGANIZATION_MEMBERS_LIMIT = 500",
    );
    expect(organizationQuerySource).toContain(
      "membersLimit: ORGANIZATION_MEMBERS_LIMIT",
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
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-queries/entities.ts",
    );
    const entitiesWindowOptionsSource = entityQuerySource.slice(
      entityQuerySource.indexOf("export const entitiesWindowOptions"),
      entityQuerySource.indexOf("export const filesystemEntitiesOptions"),
    );
    const filesystemEntitiesOptionsSource = entityQuerySource.slice(
      entityQuerySource.indexOf("export const filesystemEntitiesOptions"),
      entityQuerySource.indexOf("export const kanbanGroupOptions"),
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

  test("legacy entity redirects do not block protected shell commit", () => {
    const entityRouteSource = readRootFixture(
      "apps/web/src/routes/_protected.workspaces/$workspaceId/entities/$entityId.tsx",
    );

    expect(entityRouteSource).toContain("component: LegacyEntityRedirect");
    expect(entityRouteSource).toContain("useQuery");
    expect(entityRouteSource).toContain("DocxLoadingShell");
    expect(entityRouteSource).toContain("Navigate");
    expect(entityRouteSource).not.toContain("beforeLoad");
    expect(entityRouteSource).not.toContain("ensureRouteQueryData");
  });

  test("tools route keeps heavy catalogue UI behind Suspense", () => {
    const toolsRouteSource = readRootFixture(
      "apps/web/src/routes/_protected.knowledge/tools.tsx",
    );
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-static-catalogue-route-import.ts",
    );
    const configSource = readRootFixture("oxlint.config.ts");

    expect(toolsRouteSource).toContain("const LazyCatalogueBrowser = lazy");
    expect(toolsRouteSource).toContain("catalogue/catalogue-browser");
    expect(toolsRouteSource).toContain(
      "return { default: module.CatalogueBrowserWithRouteData };",
    );
    expect(toolsRouteSource).toContain("Route.useLoaderData");
    expect(toolsRouteSource).toContain("canManageCustomTools");
    expect(toolsRouteSource).toContain("practiceJurisdictions");
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
    expect(configSource).toContain(
      "apps/web/src/routes/_protected.knowledge/tools.tsx",
    );
  });

  test("presigned upload integration test does not mock presign helpers", () => {
    const uploadIntegrationSource = readRootFixture(
      "apps/api/src/handlers/uploads/presigned-upload.integration.test.ts",
    );

    expect(uploadIntegrationSource).toContain('mock.module("@/api/lib/s3"');
    expect(uploadIntegrationSource).not.toContain(
      'mock.module("@/api/lib/s3-presign"',
    );
  });

  test("devtools shell lazy-loads TanStack panels", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-static-devtools-import.ts",
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

    expect(pluginSource).toContain("DEVTOOLS_PACKAGES");
    expect(pluginSource).toContain("@tanstack/react-table-devtools");
    expect(pluginSource).toContain("DYNAMIC_ONLY_MODULES");
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
      "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/index.tsx",
    );

    expect(tableSource).toContain("useExternalSyncEffect(() => {");
    expect(tableSource).toContain("const element = tableWrapperRef.current");
    expect(tableSource).toContain("new ResizeObserver(updateMetrics)");
    expect(tableSource).toContain("ref={tableWrapperRef}");
    expect(tableSource).not.toContain("tableWrapperObserverRef");
    expect(tableSource).not.toContain("composeRefs(tableWrapperRef");
  });

  test("route lint forbids redirecting from beforeLoad/loader", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-beforeload-redirect.ts",
    );
    const configSource = readRootFixture("oxlint.config.ts");

    expect(pluginSource).toContain("beforeLoad");
    expect(pluginSource).toContain("loader");
    expect(pluginSource).toContain("redirect");

    expect(configSource).toContain(
      "./.oxlint-plugins/no-beforeload-redirect.ts",
    );
    expect(configSource).toContain(
      "no-beforeload-redirect/no-beforeload-redirect",
    );
    expect(configSource).toContain(
      ".oxlint-plugins/__fixtures__/no-beforeload-redirect.fixture.tsx",
    );
  });
});
