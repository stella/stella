import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiDelete, apiGet, apiPut, apiUploadDocx } from "../helpers/api";
import {
  type RouteNetworkMetrics,
  assertNetworkBaseline,
  createNetworkCollector,
  summarizeCapture,
} from "../helpers/network";
import {
  type BrowserErrorCollector,
  createBrowserErrorCollector,
  expect,
  test,
} from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

// Long enough that idle warmup requests (tool connectors, skills, usage
// entitlement on chat routes) land inside the window deterministically; the
// network baseline records them as part of the route's manifest instead of
// racing them. Costs ~30s across the walk.
const DEFAULT_SETTLE_MS = 1000;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const ROUTE_TREE_PATH = path.resolve(
  import.meta.dirname,
  "../../src/routeTree.gen.ts",
);

type RouteExpectation =
  | { kind: "rendersInPlace" }
  | { kind: "redirectsTo"; to: string }
  | { kind: "settles" };

type SmokeRoute = {
  template: string;
  path: string;
  settleMs?: number;
  // Where the route settles. Defaults to rendering in place (the pathname stays
  // put). `redirectsTo` pins a deterministic beforeLoad/Navigate target and
  // waits for that target before asserting the destination shell, so cold
  // redirect aliases do not sit on the root loader until the <main> timeout.
  // `settles` covers routes whose destination depends on env or runtime data
  // (freshly minted ids, dev-only gates), where only "left /auth and rendered"
  // is assertable.
  expectation?: RouteExpectation;
};

const STATIC_AUTHENTICATED_ROUTES: readonly SmokeRoute[] = [
  { template: "/chat", path: "/chat" },
  { template: "/chat/$threadId", path: `/chat/${randomUUID()}` },
  {
    template: "/chat/new",
    path: "/chat/new",
    expectation: { kind: "settles" },
  },
  { template: "/contacts", path: "/contacts" },
  {
    template: "/dev/autocomplete",
    path: "/dev/autocomplete",
    expectation: { kind: "settles" },
  },
  { template: "/knowledge", path: "/knowledge" },
  { template: "/knowledge/clauses", path: "/knowledge/clauses" },
  // Reachable in dev/staging (playbooks preview gate is open there); redirects
  // to /knowledge only in production where the flag is off.
  { template: "/knowledge/playbooks", path: "/knowledge/playbooks" },
  {
    template: "/knowledge/mcp",
    path: "/knowledge/mcp",
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=mcp" },
  },
  {
    template: "/knowledge/prompts",
    path: "/knowledge/prompts",
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=skill" },
  },
  {
    template: "/knowledge/skills",
    path: "/knowledge/skills",
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=skill" },
  },
  { template: "/knowledge/templates", path: "/knowledge/templates" },
  { template: "/knowledge/tools", path: "/knowledge/tools" },
  {
    template: "/settings",
    path: "/settings",
    expectation: { kind: "redirectsTo", to: "/settings/account/profile" },
  },
  {
    template: "/settings/account/beta",
    path: "/settings/account/beta",
    expectation: { kind: "settles" },
  },
  {
    template: "/settings/account/connections",
    path: "/settings/account/connections",
  },
  { template: "/settings/account/desktop", path: "/settings/account/desktop" },
  { template: "/settings/account/profile", path: "/settings/account/profile" },
  {
    template: "/settings/organization",
    path: "/settings/organization",
    expectation: { kind: "redirectsTo", to: "/settings/organization/members" },
  },
  { template: "/settings/organization/ai", path: "/settings/organization/ai" },
  {
    template: "/settings/organization/anonymization",
    path: "/settings/organization/anonymization",
  },
  {
    template: "/settings/organization/catalogue",
    path: "/settings/organization/catalogue",
    expectation: { kind: "redirectsTo", to: "/knowledge/tools" },
  },
  {
    template: "/settings/organization/document-types",
    path: "/settings/organization/document-types",
  },
  {
    template: "/settings/organization/matter-numbering",
    path: "/settings/organization/matter-numbering",
  },
  {
    template: "/settings/organization/members",
    path: "/settings/organization/members",
  },
  {
    template: "/settings/organization/usage",
    path: "/settings/organization/usage",
  },
  { template: "/todos", path: "/todos" },
  { template: "/workspaces", path: "/workspaces" },
];

// These routes need richer domain setup than cheap route smoke should own.
// Keeping them explicit means a newly added authenticated route fails this spec
// until it is either smoked or deliberately placed here.
const INTENTIONALLY_NOT_SMOKED = new Set([
  "/knowledge/tools/$skillId",
  "/workspaces/$workspaceId/invoices/$invoiceId",
]);

test("authenticated routes render without browser errors", async ({
  context,
  request,
}) => {
  test.setTimeout(240_000);

  const cleanupTasks: (() => Promise<void>)[] = [];

  try {
    const workspace = await createTestWorkspace(request, "route-smoke");
    cleanupTasks.push(
      async () => await deleteTestWorkspace(request, workspace.id),
    );

    const contactId = await createContact(request);
    cleanupTasks.push(
      async () => await apiDelete(request, `/contacts/${contactId}`),
    );

    const documentRoute = await createDocumentRoute(request, workspace);

    const routes: SmokeRoute[] = [
      ...STATIC_AUTHENTICATED_ROUTES,
      ...createWorkspaceRoutes(workspace),
      {
        template: "/contacts/$contactId",
        path: `/contacts/${contactId}`,
      },
      {
        template: "/workspaces/$workspaceId/entities/$entityId",
        path: `/workspaces/${workspace.id}/entities/${documentRoute.entityId}`,
        settleMs: 1500,
        expectation: { kind: "settles" },
      },
      {
        template: "/workspaces/$workspaceId/$viewId/document",
        path: documentRoute.path,
        settleMs: 2000,
      },
    ];

    await expectAuthenticatedRouteCoverage(routes);

    const networkResults = new Map<string, RouteNetworkMetrics>();
    for (const route of routes) {
      // eslint-disable-next-line no-await-in-loop -- each route gets an isolated page so browser errors can be attributed to its direct render without concurrent route state leaking across pages
      await test.step(route.template, async () => {
        await smokeRoute({ context, results: networkResults, route });
      });
    }

    assertNetworkBaseline(networkResults);
  } finally {
    await Promise.all(cleanupTasks.map(async (cleanup) => await cleanup()));
  }
});

const createWorkspaceRoutes = (workspace: TestWorkspace): SmokeRoute[] => [
  {
    template: "/chat/workspaces/$workspaceId/$threadId",
    path: `/chat/workspaces/${workspace.id}/${randomUUID()}`,
  },
  {
    template: "/chat/workspaces/$workspaceId/new",
    path: `/chat/workspaces/${workspace.id}/new`,
    expectation: { kind: "settles" },
  },
  {
    template: "/workspaces/$workspaceId",
    path: `/workspaces/${workspace.id}`,
    expectation: {
      kind: "redirectsTo",
      to: `/workspaces/${workspace.id}/${workspace.viewId}`,
    },
  },
  {
    template: "/workspaces/$workspaceId/expenses",
    path: `/workspaces/${workspace.id}/expenses`,
  },
  {
    template: "/workspaces/$workspaceId/invoices",
    path: `/workspaces/${workspace.id}/invoices`,
  },
  {
    template: "/workspaces/$workspaceId/timesheets",
    path: `/workspaces/${workspace.id}/timesheets`,
    expectation: {
      kind: "redirectsTo",
      to: `/workspaces/${workspace.id}/${workspace.viewId}`,
    },
  },
  {
    template: "/workspaces/$workspaceId/$viewId",
    path: `/workspaces/${workspace.id}/${workspace.viewId}`,
  },
];

const createContact = async (request: APIRequestContext): Promise<string> => {
  const contactId = randomUUID();

  await apiPut(request, "/contacts", {
    id: contactId,
    type: "person",
    displayName: `Route Smoke ${contactId.slice(0, 8)}`,
    firstName: "Route",
    lastName: "Smoke",
  });

  return contactId;
};

const createDocumentRoute = async (
  request: APIRequestContext,
  workspace: TestWorkspace,
): Promise<{ entityId: string; path: string }> => {
  const docxBuffer = await readFile(DOCX_PATH);
  const uploaded = await apiUploadDocx(
    request,
    workspace.id,
    workspace.filePropertyId,
    {
      name: "route-smoke.docx",
      mimeType: DOCX_MIME,
      buffer: docxBuffer,
    },
  );

  const entity = await apiGet<{
    fields?: {
      id: string;
      propertyId: string;
      content: { type: string };
    }[];
  }>(request, `/entities/${workspace.id}/entity/${uploaded.entityId}`);

  const fileField = entity.fields?.find(
    (field) =>
      field.propertyId === workspace.filePropertyId &&
      field.content.type === "file",
  );
  if (!fileField) {
    throw new Error("Uploaded entity did not include the expected file field");
  }

  return {
    entityId: uploaded.entityId,
    path:
      `/workspaces/${workspace.id}/${workspace.viewId}/document` +
      `?entity=${uploaded.entityId}&field=${fileField.id}`,
  };
};

const smokeRoute = async ({
  context,
  results,
  route,
}: {
  context: BrowserContext;
  results: Map<string, RouteNetworkMetrics>;
  route: SmokeRoute;
}) => {
  const expectation = route.expectation;

  if (expectation?.kind === "redirectsTo") {
    // Redirect aliases do not own UI. Assert the alias lands correctly, then
    // smoke the declared target directly so browser-error and network
    // collection belong to the page that actually renders. The alias page
    // itself is not recorded.
    await assertRedirectRoute({ context, route, expectation });
    await smokeRouteTarget({
      context,
      results,
      route: {
        template: `${route.template} target`,
        path: expectation.to,
        ...(route.settleMs === undefined ? {} : { settleMs: route.settleMs }),
        expectation: { kind: "redirectsTo", to: expectation.to },
      },
    });
    return;
  }

  await smokeRouteTarget({ context, results, route });
};

const smokeRouteTarget = async ({
  context,
  results,
  route,
}: {
  context: BrowserContext;
  results: Map<string, RouteNetworkMetrics>;
  route: SmokeRoute;
}) => {
  const page = await context.newPage();
  const browserErrors = createBrowserErrorCollector({
    tolerateColdMountWarning: true,
  });
  const detachPage = browserErrors.trackPage(page);
  const network = createNetworkCollector();
  const detachNetwork = network.trackPage(page);

  try {
    await renderSmokeRoute({ browserErrors, page, route });
    // Captured right after the settle + assertions in renderSmokeRoute (its
    // last step is browserErrors.assertEmpty), so the manifest reflects the
    // fully-rendered route. Stored under the template it received; redirect
    // targets already arrive as "<template> target".
    results.set(route.template, summarizeCapture(await network.capture()));
  } finally {
    detachNetwork();
    detachPage();
    await page.close();
  }
};

const assertRedirectRoute = async ({
  context,
  route,
  expectation,
}: {
  context: BrowserContext;
  route: SmokeRoute;
  expectation: { kind: "redirectsTo"; to: string };
}) => {
  const page = await context.newPage();
  const redirectRoute = { ...route, expectation };

  try {
    await page.goto(redirectRoute.path, { waitUntil: "domcontentloaded" });
    await expect(page, redirectRoute.template).not.toHaveURL(/\/auth(?:\/|$)/u);
    await waitForRedirectDestination(page, redirectRoute);
    assertFinalDestination(page, redirectRoute);
  } finally {
    await page.close();
  }
};

const renderSmokeRoute = async ({
  browserErrors,
  page,
  route,
}: {
  browserErrors: Pick<BrowserErrorCollector, "assertEmpty">;
  page: Page;
  route: SmokeRoute;
}) => {
  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await expect(page, route.template).not.toHaveURL(/\/auth(?:\/|$)/u);
  await waitForRedirectDestination(page, route);
  await assertNoRouteBoundary(page, route.template);
  // Cold-compiled route chunks can take longer than the default 10s expect
  // timeout to paint <main> on a fresh CI runner.
  await expect(page.locator("main").first(), route.template).toBeVisible({
    timeout: 30_000,
  });

  await page.waitForTimeout(route.settleMs ?? DEFAULT_SETTLE_MS);

  await assertNoRouteBoundary(page, route.template);
  assertFinalDestination(page, route);
  browserErrors.assertEmpty(`unexpected browser errors on ${route.template}`);
};

// A route counts as smoked only if it settled on its own component or its
// declared redirect target; bouncing to an unrelated route means the component
// under test never rendered. `settles` routes opt out because their final URL
// depends on env or runtime data.
const assertFinalDestination = (page: Page, route: SmokeRoute) => {
  const expectation = route.expectation ?? { kind: "rendersInPlace" };
  if (expectation.kind === "settles") {
    return;
  }

  const expected = expectedDestination(route, page.url());
  const actual = new URL(page.url());

  expect(
    comparableHref(actual, expected.assertSearch),
    `${route.template} settled on an unexpected route`,
  ).toBe(expected.href);
};

const waitForRedirectDestination = async (page: Page, route: SmokeRoute) => {
  if (route.expectation?.kind !== "redirectsTo") {
    return;
  }

  const expected = expectedDestination(route, page.url());

  await expect(page, `${route.template} reached redirect target`).toHaveURL(
    (actual) => comparableHref(actual, expected.assertSearch) === expected.href,
    { timeout: 30_000 },
  );
};

type ExpectedDestination = {
  href: string;
  assertSearch: boolean;
};

const expectedDestination = (
  route: SmokeRoute,
  baseUrl: string,
): ExpectedDestination => {
  const expectation = route.expectation ?? { kind: "rendersInPlace" };
  const target =
    expectation.kind === "redirectsTo" ? expectation.to : route.path;
  const expected = new URL(target, baseUrl);

  // A redirectsTo target opts into search assertion by spelling out a query
  // string (e.g. the legacy knowledge redirects must preserve ?kind=...).
  // Otherwise compare pathname only: render-in-place routes may inject default
  // search params, and a route that drops a required param (e.g. the document
  // route) bounces to a different pathname, which this assertion already catches.
  const assertSearch =
    expectation.kind === "redirectsTo" && expected.search !== "";

  return {
    assertSearch,
    href: comparableHref(expected, assertSearch),
  };
};

const comparableHref = (url: URL, assertSearch: boolean) =>
  assertSearch ? url.pathname + url.search : url.pathname;

const assertNoRouteBoundary = async (page: Page, routeTemplate: string) => {
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
    `route error boundary rendered on ${routeTemplate}`,
  ).toHaveCount(0);
};

const expectAuthenticatedRouteCoverage = async (
  routes: readonly SmokeRoute[],
) => {
  const actual = await readAuthenticatedRouteTemplates();
  const expected = [
    ...routes.map((route) => route.template),
    ...INTENTIONALLY_NOT_SMOKED,
  ].toSorted();

  expect(actual).toEqual(expected);
};

const readAuthenticatedRouteTemplates = async (): Promise<string[]> => {
  const source = await readFile(ROUTE_TREE_PATH, "utf-8");
  const marker = "export interface FileRoutesByTo {";
  const bodyStart = source.indexOf(marker);
  if (bodyStart === -1) {
    throw new Error("Could not find FileRoutesByTo in routeTree.gen.ts");
  }
  const routeBodyStart = bodyStart + marker.length;
  const bodyEnd = source.indexOf("\n}", routeBodyStart);
  if (bodyEnd === -1) {
    throw new Error("Could not find end of FileRoutesByTo in routeTree.gen.ts");
  }
  const body = source.slice(routeBodyStart, bodyEnd);

  return body
    .split("\n")
    .map(parseAuthenticatedRouteTemplate)
    .filter((route): route is string => route !== null)
    .toSorted();
};

// The generated route tree types every authenticated `to` path against a
// `Protected*` route (the `_protected` layout). Deriving the smoke set from
// that structural marker, rather than a hand-maintained prefix allow-list,
// means a newly added authenticated top-level section fails this spec until it
// is either smoked or placed in INTENTIONALLY_NOT_SMOKED.
const PROTECTED_ROUTE_LINE = /^'(?<path>[^']+)':\s*typeof\s+Protected/u;

const parseAuthenticatedRouteTemplate = (line: string): string | null =>
  PROTECTED_ROUTE_LINE.exec(line.trimStart())?.groups?.["path"] ?? null;
