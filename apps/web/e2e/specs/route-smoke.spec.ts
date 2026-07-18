import type {
  APIRequestContext,
  BrowserContext,
  Page,
  Request,
} from "@playwright/test";
import { expect, request as apiRequestFactory, test } from "@playwright/test";
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
} from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

// Long enough that idle warmup requests (tool connectors, skills, usage
// entitlement on chat routes) land inside the window deterministically; the
// network baseline records them as part of the route's manifest instead of
// racing them.
const DEFAULT_SETTLE_MS = 1000;

// Repo-root .playwright/storage-state.json — mirrors apps/web/e2e/playwright.config.ts
// (seed-test-user.ts writes it there). The route walk owns its own browser
// context and API request context (created in beforeAll) so setup/teardown are
// no longer hostage to a per-test fixture lifecycle; both need the authenticated
// storage state wired in explicitly.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

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

// The concrete route smoked by a single test case: template (stable key),
// resolved path, optional settle window, and where it is expected to land.
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

// Runtime fixtures every dynamic route path is resolved against. Populated once
// in beforeAll and shared across the per-route test cases.
type SmokeWorld = {
  workspace: TestWorkspace;
  contactId: string;
  documentRoute: { entityId: string; path: string };
};

// A route case declared at collection time. `path` is a function so dynamic
// routes (workspace/contact/document ids) resolve against the beforeAll world
// when the case actually runs, while templates stay static so the per-route
// `test()` cases and the coverage assertion can be built before setup runs.
type SmokeRouteDef = {
  template: string;
  path: (world: SmokeWorld) => string;
  settleMs?: number;
  expectation?: RouteExpectation;
};

const staticRoute = (
  template: string,
  extra: Omit<SmokeRouteDef, "template" | "path"> = {},
): SmokeRouteDef => ({ template, path: () => template, ...extra });

// Every authenticated route smoked, one case each. Order is the walk order; the
// heavy document route stays last. Kept as declarations (not live SmokeRoutes)
// so each route is its own `test()` with its own timeout instead of one 300s
// mega-test whose budget any single slow or dev-server-stalled route can blow.
const SMOKE_ROUTE_DEFS: readonly SmokeRouteDef[] = [
  staticRoute("/chat"),
  {
    template: "/chat/$threadId",
    path: () => `/chat/${randomUUID()}`,
  },
  staticRoute("/chat/new", { expectation: { kind: "settles" } }),
  staticRoute("/contacts"),
  staticRoute("/dev/autocomplete", { expectation: { kind: "settles" } }),
  staticRoute("/knowledge"),
  staticRoute("/knowledge/clauses"),
  // Reachable in dev/staging (playbooks preview gate is open there); redirects
  // to /knowledge only in production where the flag is off.
  staticRoute("/knowledge/playbooks"),
  staticRoute("/knowledge/mcp", {
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=mcp" },
  }),
  staticRoute("/knowledge/prompts", {
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=skill" },
  }),
  staticRoute("/knowledge/skills", {
    expectation: { kind: "redirectsTo", to: "/knowledge/tools?kind=skill" },
  }),
  staticRoute("/knowledge/styles"),
  staticRoute("/knowledge/templates"),
  staticRoute("/knowledge/tools"),
  staticRoute("/settings", {
    expectation: { kind: "redirectsTo", to: "/settings/account/profile" },
  }),
  staticRoute("/settings/account/beta", { expectation: { kind: "settles" } }),
  staticRoute("/settings/account/connections"),
  staticRoute("/settings/account/desktop"),
  staticRoute("/settings/account/profile"),
  staticRoute("/settings/organization", {
    expectation: { kind: "redirectsTo", to: "/settings/organization/members" },
  }),
  staticRoute("/settings/organization/ai"),
  staticRoute("/settings/organization/anonymization"),
  staticRoute("/settings/organization/audit-logs"),
  staticRoute("/settings/organization/catalogue", {
    expectation: { kind: "redirectsTo", to: "/knowledge/tools" },
  }),
  staticRoute("/settings/organization/document-types"),
  staticRoute("/settings/organization/matter-numbering"),
  staticRoute("/settings/organization/members"),
  staticRoute("/settings/organization/usage"),
  staticRoute("/todos"),
  staticRoute("/workspaces"),
  {
    template: "/chat/workspaces/$workspaceId/$threadId",
    path: (world) => `/chat/workspaces/${world.workspace.id}/${randomUUID()}`,
  },
  {
    template: "/chat/workspaces/$workspaceId/new",
    path: (world) => `/chat/workspaces/${world.workspace.id}/new`,
    expectation: { kind: "settles" },
  },
  {
    template: "/workspaces/$workspaceId",
    path: (world) => `/workspaces/${world.workspace.id}`,
    expectation: { kind: "redirectsTo", to: "" },
  },
  {
    template: "/workspaces/$workspaceId/expenses",
    path: (world) => `/workspaces/${world.workspace.id}/expenses`,
  },
  {
    template: "/workspaces/$workspaceId/invoices",
    path: (world) => `/workspaces/${world.workspace.id}/invoices`,
  },
  {
    template: "/workspaces/$workspaceId/timesheets",
    path: (world) => `/workspaces/${world.workspace.id}/timesheets`,
    expectation: { kind: "redirectsTo", to: "" },
  },
  {
    template: "/workspaces/$workspaceId/$viewId",
    path: (world) =>
      `/workspaces/${world.workspace.id}/${world.workspace.viewId}`,
  },
  {
    template: "/contacts/$contactId",
    path: (world) => `/contacts/${world.contactId}`,
  },
  {
    template: "/workspaces/$workspaceId/entities/$entityId",
    path: (world) =>
      `/workspaces/${world.workspace.id}/entities/${world.documentRoute.entityId}`,
    settleMs: 1500,
    expectation: { kind: "settles" },
  },
  {
    template: "/workspaces/$workspaceId/$viewId/document",
    path: (world) => world.documentRoute.path,
    settleMs: 2000,
  },
];

// Redirect targets for workspace-scoped aliases depend on the runtime view id,
// so their `expectation.to` is resolved here rather than in the static table.
const resolveExpectation = (
  def: SmokeRouteDef,
  world: SmokeWorld,
): RouteExpectation | undefined => {
  if (def.expectation?.kind !== "redirectsTo") {
    return def.expectation;
  }
  if (def.expectation.to !== "") {
    return def.expectation;
  }
  return {
    kind: "redirectsTo",
    to: `/workspaces/${world.workspace.id}/${world.workspace.viewId}`,
  };
};

const resolveRoute = (def: SmokeRouteDef, world: SmokeWorld): SmokeRoute => {
  const expectation = resolveExpectation(def, world);
  return {
    template: def.template,
    path: def.path(world),
    ...(def.settleMs === undefined ? {} : { settleMs: def.settleMs }),
    ...(expectation === undefined ? {} : { expectation }),
  };
};

// These routes need richer domain setup than cheap route smoke should own.
// Keeping them explicit means a newly added authenticated route fails the
// coverage assertion until it is either smoked or deliberately placed here.
const INTENTIONALLY_NOT_SMOKED = new Set([
  "/knowledge/tools/$skillId",
  "/workspaces/$workspaceId/invoices/$invoiceId",
  "/workspaces/$workspaceId/reports/$exportId",
]);

// One serial group so the expensive workspace/contact/document setup runs once
// and is shared across every route case. Each route is its own `test()` with
// the config's per-test timeout: a single slow route (cold compile) or a
// dev-server sub-resource stall now fails and is attributed to that one route
// instead of consuming a single 300s budget shared by all ~45 routes.
test.describe
  .serial("authenticated routes render without browser errors", () => {
  let apiRequest: APIRequestContext;
  let context: BrowserContext;
  let world: SmokeWorld | null = null;
  const networkResults = new Map<string, RouteNetworkMetrics>();

  test.beforeAll(async ({ browser }) => {
    apiRequest = await apiRequestFactory.newContext({
      storageState: STORAGE_STATE,
    });
    context = await browser.newContext({ storageState: STORAGE_STATE });

    const workspace = await createTestWorkspace(apiRequest, "route-smoke");
    const contactId = await createContact(apiRequest);
    const documentRoute = await createDocumentRoute(apiRequest, workspace);
    world = { workspace, contactId, documentRoute };
  });

  test.afterAll(async () => {
    const failures: unknown[] = [];
    if (world !== null) {
      // Best-effort but total: attempt every delete even if one throws, so a
      // single failed cleanup cannot strand the other fixture. Runs on the
      // beforeAll-owned request context (not a per-test fixture), so it cannot
      // race a timing-out test body into the "context closed" masking error.
      try {
        await apiDelete(apiRequest, `/contacts/${world.contactId}`);
      } catch (error) {
        failures.push(error);
      }
      try {
        await deleteTestWorkspace(apiRequest, world.workspace.id);
      } catch (error) {
        failures.push(error);
      }
    }
    await context?.close();
    await apiRequest?.dispose();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "route-smoke teardown failed to delete one or more fixtures",
      );
    }
  });

  test("route coverage matches the authenticated route tree", async () => {
    await expectAuthenticatedRouteCoverage(SMOKE_ROUTE_DEFS);
  });

  // Declared via a helper (not a closure literal inside the loop) so each
  // parametrized `test()` is a plain call in the loop body. The shared
  // context/world/results it closes over are group-scoped and assigned once in
  // beforeAll.
  const declareRouteTest = (def: SmokeRouteDef) => {
    test(def.template, async () => {
      if (world === null) {
        throw new Error("route-smoke world was not initialized in beforeAll");
      }
      await smokeRoute({
        context,
        results: networkResults,
        route: resolveRoute(def, world),
      });
    });
  };
  for (const def of SMOKE_ROUTE_DEFS) {
    declareRouteTest(def);
  }

  test("network manifest matches the committed baseline", () => {
    assertNetworkBaseline(networkResults);
  });
});

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
    await gotoSmokeRoute(page, redirectRoute);
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
  await gotoSmokeRoute(page, route);
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

// `goto` waits for DOMContentLoaded, which a render-blocking `<head>`
// sub-resource (e.g. the dev-only /@tanstack-start/styles.css aggregation, or a
// module the dev server stalls on) gates: if the server never answers that one
// request, the document is parsed but DCL never fires and `goto` hits the
// navigation timeout with an opaque "Timeout exceeded". Naming the still-pending
// request(s) turns that into a diagnosable "the dev server stalled on X" so the
// culprit sub-resource is visible in the failure instead of the trace only.
const gotoSmokeRoute = async (page: Page, route: SmokeRoute) => {
  const inflight = new Set<string>();
  const onRequest = (request_: Request) => inflight.add(request_.url());
  const onSettled = (request_: Request) => inflight.delete(request_.url());
  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);

  try {
    await page.goto(route.path, { waitUntil: "domcontentloaded" });
  } catch (error) {
    if (error instanceof Error && /Timeout.*exceeded/u.test(error.message)) {
      const pending = [...inflight];
      if (pending.length > 0) {
        const pendingList = pending.map((url) => `  ${url}`).join("\n");
        error.message += `\n\nDOMContentLoaded never fired on ${route.template} (${route.path}); the dev server left ${pending.length} request(s) unanswered. A render-blocking sub-resource that never responds blocks DCL and stalls navigation:\n${pendingList}`;
      }
    }
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
  }
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
  routeDefs: readonly SmokeRouteDef[],
) => {
  const actual = await readAuthenticatedRouteTemplates();
  const expected = [
    ...routeDefs.map((def) => def.template),
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
// means a newly added authenticated top-level section fails the coverage test
// until it is either smoked or placed in INTENTIONALLY_NOT_SMOKED.
const PROTECTED_ROUTE_LINE = /^'(?<path>[^']+)':\s*typeof\s+Protected/u;

const parseAuthenticatedRouteTemplate = (line: string): string | null =>
  PROTECTED_ROUTE_LINE.exec(line.trimStart())?.groups?.["path"] ?? null;
