import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
  Request,
} from "@playwright/test";
import { expect, request as apiRequestFactory, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  partitionRoundRobin,
  resolveE2eExecutionProfile,
} from "../execution-profile";
import { apiDelete, apiPut } from "../helpers/api";
import { ROUTE_ERROR_HEADING } from "../helpers/app-shell";
import { findChromeDividerProblems } from "../helpers/chrome-divider";
import {
  CORRESPONDENCE_SMOKE_SUBJECT,
  createTestCorrespondence,
} from "../helpers/correspondence";
import {
  E2E_CLEANUP_TARGET_TYPE,
  registerDeferredE2eCleanup,
} from "../helpers/deferred-cleanup";
import { createUploadedDocumentRoute } from "../helpers/document";
import {
  type RouteNetworkMetrics,
  WATERFALL_DEPTH_RESAMPLES,
  assertNetworkBaseline,
  assertNetworkBaselineCoverage,
  baselineWaterfallDepth,
  createNetworkCollector,
  mergeNetworkBaseline,
  mergeResampledMetrics,
  summarizeCapture,
} from "../helpers/network";
import { declarePublicKnowledgeSmoke } from "../helpers/public-knowledge-smoke";
import {
  assertSmokeRouteCoverage,
  networkBaselineKey,
} from "../helpers/smoke-route-coverage";
import {
  SMOKE_ROUTE_DEFS,
  type SmokeRouteDef,
  type SmokeWorld,
  type RouteExpectation,
} from "../helpers/smoke-route-defs";
import { createBrowserErrorCollector } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

// Every route retains the former one-second observation floor so delayed
// warmups remain visible. After that floor, tracked API activity may finish
// the longer document-route windows early once it stays quiet.
const NETWORK_QUIET_MS = 500;
const DEFAULT_SETTLE_MS = 1000;

// Repo-root .playwright/storage-state.json — mirrors apps/web/e2e/playwright.config.ts
// (seed-test-user.ts writes it there). The route walk owns its API request
// context (created in beforeAll) and opens a fresh browser context for every
// page it loads, so setup/teardown are no longer hostage to a per-test fixture
// lifecycle; both need the authenticated storage state wired in explicitly.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const ROUTE_TREE_PATH = path.resolve(
  import.meta.dirname,
  "../../src/routeTree.gen.ts",
);

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

const declareRouteSmokeGroup = ({
  defs,
  name,
  requireAllRoutes,
}: {
  defs: readonly SmokeRouteDef[];
  name: string;
  requireAllRoutes: boolean;
}) => {
  // Serial within one fixture-owning group; separate groups are independent
  // Playwright scheduling units and can run on different workers or CI shards.
  test.describe.serial(name, () => {
    let apiRequest: APIRequestContext;
    let browserForPages: Browser;
    let world: SmokeWorld | null = null;
    // Recorded the moment each fixture is created (not only after the whole
    // setup succeeds), so a registry failure still tears down what exists.
    let createdWorkspace: SmokeWorld["workspace"] | null = null;
    let createdContactId: string | null = null;
    let workspaceCleanupRegistered = false;
    let contactCleanupRegistered = false;
    const networkResults = new Map<string, RouteNetworkMetrics>();

    test.beforeAll(async ({ browser }, testInfo) => {
      apiRequest = await apiRequestFactory.newContext({
        storageState: STORAGE_STATE,
      });
      browserForPages = browser;

      const workspace = await createTestWorkspace(apiRequest, "route-smoke");
      createdWorkspace = workspace;
      await registerDeferredE2eCleanup(testInfo.project.outputDir, {
        type: E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
        id: workspace.id,
      });
      workspaceCleanupRegistered = true;
      const contactId = await createContact(apiRequest);
      createdContactId = contactId;
      await registerDeferredE2eCleanup(testInfo.project.outputDir, {
        type: E2E_CLEANUP_TARGET_TYPE.CONTACT,
        id: contactId,
      });
      contactCleanupRegistered = true;
      const documentRoute = await createUploadedDocumentRoute({
        fileName: "route-smoke.docx",
        request: apiRequest,
        workspace,
      });
      const correspondenceId = await createTestCorrespondence(workspace.id);
      world = { workspace, contactId, documentRoute, correspondenceId };
    });

    test.afterAll(async () => {
      // Registered API fixtures are deleted by global teardown after every
      // measured page is closed. Only registry failures fall back to immediate
      // cleanup here; the run is already failing in that case.
      const failures: unknown[] = [];
      if (createdContactId !== null && !contactCleanupRegistered) {
        try {
          await apiDelete(apiRequest, `/contacts/${createdContactId}`);
        } catch (error) {
          failures.push(error);
        }
      }
      if (createdWorkspace !== null && !workspaceCleanupRegistered) {
        try {
          await deleteTestWorkspace(apiRequest, createdWorkspace.id);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await apiRequest.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "route-smoke teardown failed to release one or more fixtures",
        );
      }
    });

    // Declared via a helper (not a closure literal inside the loop) so each
    // parametrized `test()` is a plain call in the loop body. The shared
    // browser/world/results it closes over are group-scoped and assigned once in
    // beforeAll.
    const declareRouteTest = (def: SmokeRouteDef) => {
      test(def.template, async () => {
        if (world === null) {
          throw new Error("route-smoke world was not initialized in beforeAll");
        }
        await smokeRoute({
          browser: browserForPages,
          results: networkResults,
          route: resolveRoute(def, world),
        });
      });
    };
    for (const def of defs) {
      declareRouteTest(def);
    }

    test("network manifest matches the committed baseline", async () => {
      await test.info().attach("observed-network-baseline", {
        body: JSON.stringify(
          mergeNetworkBaseline(null, networkResults),
          null,
          2,
        ),
        contentType: "application/json",
      });
      assertNetworkBaseline(networkResults, { requireAllRoutes });
    });
  });
};

const baselineMode = process.env["E2E_NETWORK_BASELINE"];
declarePublicKnowledgeSmoke({ mode: "disabled" });

test("route coverage matches the authenticated route tree", async () => {
  await expectAuthenticatedRouteCoverage(SMOKE_ROUTE_DEFS);
  // A write run may be adding the missing route entry; check the committed
  // baseline only in comparison mode.
  if (baselineMode !== "write" && baselineMode !== "rewrite") {
    assertNetworkBaselineCoverage(SMOKE_ROUTE_DEFS.map(networkBaselineKey));
  }
});

if (baselineMode === "write" || baselineMode === "rewrite") {
  // Baseline writes need one complete result set and one writer. Normal checks
  // use isolated groups because each independently compares its observed routes
  // against the same committed per-route budgets.
  declareRouteSmokeGroup({
    defs: SMOKE_ROUTE_DEFS,
    name: "authenticated routes render without browser errors",
    requireAllRoutes: true,
  });
} else {
  const { routeSmokeGroupCount } = resolveE2eExecutionProfile(
    process.env["E2E_EXECUTION_PROFILE"],
  );
  const groups = partitionRoundRobin(SMOKE_ROUTE_DEFS, routeSmokeGroupCount);
  for (const [groupIndex, defs] of groups.entries()) {
    declareRouteSmokeGroup({
      defs,
      name: `authenticated routes render without browser errors ${groupIndex + 1}/${groups.length}`,
      requireAllRoutes: false,
    });
  }
}

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

const smokeRoute = async ({
  browser,
  results,
  route,
}: {
  browser: Browser;
  results: Map<string, RouteNetworkMetrics>;
  route: SmokeRoute;
}) => {
  const expectation = route.expectation;

  if (expectation?.kind === "redirectsTo") {
    // Redirect aliases do not own UI. Assert the alias lands correctly, then
    // smoke the declared target directly so browser-error and network
    // collection belong to the page that actually renders. The alias page
    // itself is not recorded.
    await assertRedirectRoute({ browser, route, expectation });
    await smokeRouteTarget({
      browser,
      results,
      route: {
        template: networkBaselineKey(route),
        path: expectation.to,
        ...(route.settleMs === undefined ? {} : { settleMs: route.settleMs }),
        expectation: { kind: "redirectsTo", to: expectation.to },
      },
    });
    return;
  }

  await smokeRouteTarget({ browser, results, route });
};

const smokeRouteTarget = async ({
  browser,
  results,
  route,
}: {
  browser: Browser;
  results: Map<string, RouteNetworkMetrics>;
  route: SmokeRoute;
}) => {
  // A deeper reading than the budget is either a regression or a fast sample
  // over-reading by one; only more samples tell them apart. A regression
  // survives every re-measurement, jitter does not. Samples run one at a time
  // on purpose: a second page in flight would distort the timing being read.
  const budget = baselineWaterfallDepth(route.template);
  const resampleDeeperReading = async (
    metrics: RouteNetworkMetrics,
    remaining: number,
  ): Promise<RouteNetworkMetrics> => {
    if (budget === null || metrics.depth <= budget || remaining === 0) {
      return metrics;
    }
    const again = await measureRouteTarget({ browser, route });
    return resampleDeeperReading(
      mergeResampledMetrics(metrics, again),
      remaining - 1,
    );
  };

  const metrics = await resampleDeeperReading(
    await measureRouteTarget({ browser, route }),
    WATERFALL_DEPTH_RESAMPLES,
  );
  // Stored under the template it received; redirect targets arrive as
  // "<template> target".
  results.set(route.template, metrics);
};

const measureRouteTarget = async ({
  browser,
  route,
}: {
  browser: Browser;
  route: SmokeRoute;
}): Promise<RouteNetworkMetrics> => {
  const { context, page } = await openCleanPage(browser);
  const browserErrors = createBrowserErrorCollector({
    tolerateColdMountWarning: true,
  });
  const detachPage = browserErrors.trackPage(page);
  const network = createNetworkCollector();
  const detachNetwork = network.trackPage(page);

  try {
    await renderSmokeRoute({ page, route });
    await network.waitForQuiet({
      idleMs: NETWORK_QUIET_MS,
      minimumObservationMs: DEFAULT_SETTLE_MS,
      timeoutMs: route.settleMs ?? DEFAULT_SETTLE_MS,
    });
    await assertNoRouteBoundary(page, route.template);
    assertFinalDestination(page, route);
    await assertRouteContentVisible(page, route.template);
    // The chrome draws the one divider under the breadcrumb bar; a page row
    // with its own top border on that line doubles it into a 2px rule.
    expect(
      await findChromeDividerProblems(page),
      `${route.template} must show exactly one divider under the app chrome`,
    ).toEqual([]);
    browserErrors.assertEmpty(`unexpected browser errors on ${route.template}`);
    // Captured after the route shell and tracked API work are ready, so the
    // manifest reflects the fully-rendered route.
    return summarizeCapture(await network.capture());
  } finally {
    detachNetwork();
    detachPage();
    await context.close();
  }
};

const assertRedirectRoute = async ({
  browser,
  route,
  expectation,
}: {
  browser: Browser;
  route: SmokeRoute;
  expectation: { kind: "redirectsTo"; to: string };
}) => {
  const { context, page } = await openCleanPage(browser);
  const redirectRoute = { ...route, expectation };

  try {
    await gotoSmokeRoute(page, redirectRoute);
    await expect(page, redirectRoute.template).not.toHaveURL(/\/auth(?:\/|$)/u);
    await waitForRedirectDestination(page, redirectRoute);
    assertFinalDestination(page, redirectRoute);
  } finally {
    await context.close();
  }
};

// Browser storage the app writes on one route (for example the inspector tabs
// it restores from localStorage) would otherwise replay on the next route and
// fire the earlier route's requests inside this route's capture, at whatever
// point the restore lands. Every page therefore gets its own context seeded only with the
// authenticated storage state; server-side fixtures stay shared.
const openCleanPage = async (
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  try {
    // Guards the clean start: the page must not inherit browser storage that
    // an earlier route wrote into a shared context.
    expect(
      storedKeys(await context.storageState()),
      "route-smoke pages must start from the seeded storage state only",
    ).toEqual(await seededStorageKeys(browser));
    return { context, page: await context.newPage() };
  } catch (error) {
    await context.close();
    throw error;
  }
};

const storedKeys = ({
  origins,
}: Awaited<ReturnType<BrowserContext["storageState"]>>): string[] =>
  origins
    .flatMap(({ origin, localStorage }) =>
      localStorage.map(({ name }) => `${origin} ${name}`),
    )
    .toSorted();

let seededStorageKeysPromise: Promise<string[]> | null = null;

// Read once from a context no page has ever used.
const seededStorageKeys = async (browser: Browser): Promise<string[]> => {
  seededStorageKeysPromise ??= (async () => {
    const pristine = await browser.newContext({ storageState: STORAGE_STATE });
    try {
      return storedKeys(await pristine.storageState());
    } finally {
      await pristine.close();
    }
  })();
  return await seededStorageKeysPromise;
};

const renderSmokeRoute = async ({
  page,
  route,
}: {
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
    page.getByRole("heading", { name: ROUTE_ERROR_HEADING }),
    `route error boundary rendered on ${routeTemplate}`,
  ).toHaveCount(0);
};

const assertRouteContentVisible = async (page: Page, routeTemplate: string) => {
  if (
    routeTemplate ===
    "/workspaces/$workspaceId/correspondence/$correspondenceId"
  ) {
    await expect(
      page.getByRole("heading", {
        name: CORRESPONDENCE_SMOKE_SUBJECT,
        exact: true,
      }),
      "the correspondence detail renders the persisted message",
    ).toBeVisible();
    return;
  }
  if (routeTemplate !== "/workspaces") {
    return;
  }

  await expect(
    page.locator("main h2").first(),
    "the matters route paints its first matter inside the viewport",
  ).toBeInViewport();
};

const expectAuthenticatedRouteCoverage = async (
  routeDefs: readonly SmokeRouteDef[],
) => {
  assertSmokeRouteCoverage(await readFile(ROUTE_TREE_PATH, "utf-8"), routeDefs);
};
