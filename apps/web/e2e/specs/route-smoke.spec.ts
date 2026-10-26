import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
  Request,
} from "@playwright/test";
import { expect, request as apiRequestFactory, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import {
  partitionRoundRobin,
  resolveE2eExecutionProfile,
} from "../execution-profile";
import { apiDelete, apiGet, apiPut, E2E_API_ORIGIN } from "../helpers/api";
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
  assertNetworkBaseline,
  assertNetworkBaselineCoverage,
  createNetworkCollector,
  mergeNetworkBaseline,
  type RouteNetworkMetrics,
  summarizeCapture,
} from "../helpers/network";
import { declarePublicKnowledgeSmoke } from "../helpers/public-knowledge-smoke";
import {
  createRenderRecorder,
  readRenderCensus,
  type RouteRenderMetrics,
} from "../helpers/render-census";
import {
  installRenderCommitHook,
  RENDER_CENSUS_GLOBAL,
} from "../helpers/render-census-hook";
import {
  parseRouteScaleLedger,
  routeScaleCensus,
  type RouteScaleMeasurement,
} from "../helpers/route-scale";
import {
  addedLedgerEntries,
  routeScaleLedgerMembership,
} from "../helpers/route-scale-ledger";
import { signInWithEmailOtp } from "../helpers/sign-in";
import {
  assertSmokeRouteCoverage,
  networkBaselineKey,
} from "../helpers/smoke-route-coverage";
import {
  type RouteExpectation,
  SMOKE_ROUTE_DEFS,
  type SmokeRouteDef,
  type SmokeWorld,
} from "../helpers/smoke-route-defs";
import { getSmokeWorlds } from "../helpers/smoke-world";
import { createBrowserErrorCollector } from "../helpers/test";
import { listTimeBillingRoutes } from "../helpers/time-billing-routes";
import { declareVisualSandboxSmoke } from "../helpers/visual-sandbox-smoke";
import {
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "../helpers/workspace";
import scaleLedger from "../route-scale-ledger.json" with { type: "json" };

// Every route retains the former one-second observation floor so delayed
// warmups remain visible. After that floor, tracked API activity may finish
// the longer document-route windows early once it stays quiet.
const NETWORK_QUIET_MS = 500;
const DEFAULT_SETTLE_MS = 1000;
const GIT_REF_OUTPUT_MAX_BYTES = 64 * 1024;
const ROUTE_SCALE_LEDGER_OUTPUT_MAX_BYTES = 256 * 1024;
const SCALE_LEDGER = parseRouteScaleLedger(JSON.stringify(scaleLedger));

// Repo-root .playwright/storage-state.json — mirrors apps/web/e2e/playwright.config.ts
// (seed-test-user.ts writes it there). The route walk owns its API request
// context (created in beforeAll) and opens a fresh browser context for every
// page it loads, so setup/teardown are no longer hostage to a per-test fixture
// lifecycle; both need the authenticated storage state wired in explicitly.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const routeScaleLedgerAdditions = (): string[] => {
  const baseRef = "origin/main";
  const resolved = spawnSync(
    "git",
    [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: GIT_REF_OUTPUT_MAX_BYTES },
  );
  if (resolved.status !== 0) {
    return [`base ${baseRef} could not be resolved`];
  }
  const commit = resolved.stdout.trim();
  const ledgerPath = "apps/web/e2e/route-scale-ledger.json";
  const base = spawnSync("git", ["show", `${commit}:${ledgerPath}`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: ROUTE_SCALE_LEDGER_OUTPUT_MAX_BYTES,
  });
  if (base.status !== 0) {
    if (/exists on disk, but not in|does not exist in/u.test(base.stderr)) {
      return addedLedgerEntries(
        routeScaleLedgerMembership(JSON.stringify(scaleLedger)),
        null,
      );
    }
    return [`git show ${commit}:${ledgerPath} failed: ${base.stderr}`];
  }
  return addedLedgerEntries(
    routeScaleLedgerMembership(JSON.stringify(scaleLedger)),
    routeScaleLedgerMembership(base.stdout),
  );
};
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
  storageState?: Awaited<ReturnType<APIRequestContext["storageState"]>>;
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

const resolveRoute = (
  def: SmokeRouteDef,
  world: SmokeWorld & {
    storageState?: Awaited<ReturnType<APIRequestContext["storageState"]>>;
  },
): SmokeRoute => {
  const expectation = resolveExpectation(def, world);
  return {
    template: def.template,
    path: def.path(world),
    ...(world.storageState === undefined
      ? {}
      : { storageState: world.storageState }),
    ...(def.settleMs === undefined ? {} : { settleMs: def.settleMs }),
    ...(expectation === undefined ? {} : { expectation }),
  };
};

type TimeBillingRedirectDestinationOptions = {
  template: string;
  workspace: TestWorkspace;
};

const timeBillingRedirectDestination = ({
  template,
  workspace,
}: TimeBillingRedirectDestinationOptions): string => {
  // The workspace index forwards to the workspace's default view.
  if (template.startsWith("/workspaces/")) {
    return `/workspaces/${workspace.id}/${workspace.viewId}`;
  }
  if (template.startsWith("/admin/")) {
    return "/admin/members";
  }
  if (template === "/time") {
    return "/workspaces";
  }
  throw new Error(`No unenrolled redirect expectation for ${template}`);
};

const declareRouteSmokeGroup = ({
  defs,
  name,
  requireAllRoutes,
  checkUnenrolledRoutes,
}: {
  defs: readonly SmokeRouteDef[];
  name: string;
  requireAllRoutes: boolean;
  checkUnenrolledRoutes: boolean;
}) => {
  // Keep the existing scheduling groups; the single route-smoke worker shares
  // one pair of worlds across them.
  test.describe.serial(name, () => {
    let apiRequest: APIRequestContext;
    let browserForPages: Browser;
    let world: SmokeWorld | null = null;
    let worlds: Awaited<ReturnType<typeof getSmokeWorlds>>;
    // Recorded the moment each fixture is created (not only after the whole
    // setup succeeds), so a registry failure still tears down what exists.
    let createdWorkspace: SmokeWorld["workspace"] | null = null;
    let createdContactId: string | null = null;
    let workspaceCleanupRegistered = false;
    let contactCleanupRegistered = false;
    const networkResults = new Map<string, RouteNetworkMetrics>();
    const smallScaleResults = new Map<string, RouteNetworkMetrics>();
    const scaleResults = new Map<string, RouteNetworkMetrics>();
    const smallRenderResults = new Map<string, RouteRenderMetrics>();
    const largeRenderResults = new Map<string, RouteRenderMetrics>();

    test.beforeAll(async ({ browser }, testInfo) => {
      // timeout: build the baseline world plus two isolated 100/1000-row matters before measuring routes.
      test.setTimeout(180_000);
      apiRequest = await apiRequestFactory.newContext({
        storageState: STORAGE_STATE,
      });
      browserForPages = browser;
      const navigation = await apiGet<{ features: { timeBilling: boolean } }>(
        apiRequest,
        "/workspaces/navigation",
      );
      expect(
        navigation.features.timeBilling,
        "the persisted smoke principal is enrolled and verified",
      ).toBe(true);

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
      const sessionResponse = await apiRequest.get(
        `${E2E_API_ORIGIN}/api/auth/get-session`,
      );
      expect(sessionResponse.ok()).toBe(true);
      const {
        session: { activeOrganizationId },
        user: { email },
      } = v.parse(
        v.object({
          session: v.object({ activeOrganizationId: v.string() }),
          user: v.object({ email: v.string() }),
        }),
        await sessionResponse.json(),
      );
      const correspondenceId = await createTestCorrespondence(workspace.id, {
        organizationId: activeOrganizationId,
        email,
      });
      world = { workspace, contactId, documentRoute, correspondenceId };
      worlds = await getSmokeWorlds(testInfo.project.outputDir);
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
        // timeout: three sequential worlds budget the former 60s route allowance for each navigation.
        test.setTimeout(180_000);
        if (world === null) {
          throw new Error("route-smoke baseline world was not initialized");
        }
        // Preserve the main-owned baseline's fixture cardinality.
        await smokeRoute({
          browser: browserForPages,
          results: networkResults,
          route: resolveRoute(def, world),
        });
        await smokeRoute({
          browser: browserForPages,
          results: smallScaleResults,
          renderResults: smallRenderResults,
          route: resolveRoute(def, worlds.small),
        });
        await smokeRoute({
          browser: browserForPages,
          results: scaleResults,
          renderResults: largeRenderResults,
          route: resolveRoute(def, worlds.large),
        });
        const key = networkBaselineKey(def);
        const small = smallScaleResults.get(key);
        const large = scaleResults.get(key);
        const smallRenders = smallRenderResults.get(key);
        const largeRenders = largeRenderResults.get(key);
        if (
          small === undefined ||
          large === undefined ||
          smallRenders === undefined ||
          largeRenders === undefined
        ) {
          throw new Error(`Missing paired route measurement: ${key}`);
        }
        await test.info().attach("matter-scale", {
          body: JSON.stringify(
            {
              route: key,
              cardinalities: {
                small: worlds.small.cardinalities,
                large: worlds.large.cardinalities,
              },
              small,
              large,
              renders: { small: smallRenders, large: largeRenders },
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      });
    };
    for (const def of defs) {
      declareRouteTest(def);
    }

    if (checkUnenrolledRoutes) {
      test("unenrolled callers leave every time-billing route before its loader", async () => {
        test.setTimeout(180_000);
        const negativeRequest = await apiRequestFactory.newContext({
          extraHTTPHeaders: {
            origin: new URL(
              process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
            ).origin,
          },
        });
        let negativeWorkspace: TestWorkspace | null = null;
        let negativeOrganizationId: string | null = null;
        const gatedRoutes = listTimeBillingRoutes();
        expect(gatedRoutes.length).toBeGreaterThan(0);
        try {
          const token = randomUUID();
          await signInWithEmailOtp(
            negativeRequest,
            `unenrolled-route-smoke-${token}@stella.dev`,
          );
          const organizationResponse = await negativeRequest.post(
            `${E2E_API_ORIGIN}/api/auth/organization/create`,
            {
              data: {
                name: `Unenrolled route smoke ${token}`,
                slug: `unenrolled-smoke-${token}`,
              },
            },
          );
          expect(
            organizationResponse.ok(),
            await organizationResponse.text(),
          ).toBe(true);
          const organization: unknown = await organizationResponse.json();
          if (
            typeof organization !== "object" ||
            organization === null ||
            !("id" in organization) ||
            typeof organization.id !== "string"
          ) {
            throw new Error("Organization creation returned no id");
          }
          negativeOrganizationId = organization.id;
          const activation = await negativeRequest.post(
            `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
            { data: { organizationId: negativeOrganizationId } },
          );
          expect(activation.ok(), await activation.text()).toBe(true);
          const sessionResponse = await negativeRequest.get(
            `${E2E_API_ORIGIN}/api/auth/get-session`,
            { params: { disableCookieCache: "true" } },
          );
          expect(sessionResponse.ok()).toBe(true);
          expect(await sessionResponse.json()).toMatchObject({
            user: { emailVerified: true },
            session: { activeOrganizationId: negativeOrganizationId },
          });
          negativeWorkspace = await createTestWorkspace(
            negativeRequest,
            "unenrolled-route-smoke",
          );
          const workspace = negativeWorkspace;
          const workspaceId = workspace.id;
          const storageState = await negativeRequest.storageState();
          const navigation = await apiGet<{
            features: { timeBilling: boolean };
          }>(negativeRequest, "/workspaces/navigation");
          expect(
            navigation.features.timeBilling,
            "the isolated verified principal is not enrolled",
          ).toBe(false);
          const isolatedBrowser = browserForPages;
          for (const gatedRoute of gatedRoutes) {
            const template = gatedRoute.routePath.replace("/_protected", "");
            const routePath = template
              .replace("$workspaceId", () => workspaceId)
              .replace("$invoiceId", () => randomUUID());
            const destination = timeBillingRedirectDestination({
              template,
              workspace,
            });
            await test.step(template, async () => {
              const { context, page } = await openCleanPage(
                isolatedBrowser,
                storageState,
              );
              const browserErrors = createBrowserErrorCollector({
                tolerateColdMountWarning: true,
              });
              const detachPage = browserErrors.trackPage(page);
              try {
                const route = {
                  template,
                  path: routePath,
                  expectation: { kind: "redirectsTo", to: destination },
                } as const satisfies SmokeRoute;
                await renderSmokeRoute({ page, route });
                assertFinalDestination(page, route);
                await assertNoRouteBoundary(page, template);
                browserErrors.assertEmpty(
                  `unexpected browser errors on ${template}`,
                );
              } finally {
                detachPage();
                await context.close();
              }
            });
          }
        } finally {
          try {
            if (negativeWorkspace !== null) {
              await deleteTestWorkspace(negativeRequest, negativeWorkspace.id);
            }
          } finally {
            try {
              if (negativeOrganizationId !== null) {
                const deleted = await negativeRequest.post(
                  `${E2E_API_ORIGIN}/api/auth/organization/delete`,
                  { data: { organizationId: negativeOrganizationId } },
                );
                expect(deleted.ok(), await deleted.text()).toBe(true);
              }
            } finally {
              await negativeRequest.dispose();
            }
          }
        }
      });
    }

    test("route cost stays bounded as the matter grows tenfold", () => {
      // A route missing either measurement stays absent and fails the census.
      const measurements = (
        network: ReadonlyMap<string, RouteNetworkMetrics>,
        renders: ReadonlyMap<string, RouteRenderMetrics>,
      ) => {
        const joined = new Map<string, RouteScaleMeasurement>();
        for (const [route, metrics] of network) {
          const routeRenders = renders.get(route);
          if (routeRenders !== undefined) {
            joined.set(route, { network: metrics, renders: routeRenders });
          }
        }
        return joined;
      };
      const problems = routeScaleCensus({
        routes: defs.map(networkBaselineKey),
        small: measurements(smallScaleResults, smallRenderResults),
        large: measurements(scaleResults, largeRenderResults),
        ledger: SCALE_LEDGER,
      });
      expect(problems).toEqual([]);
    });

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
declareVisualSandboxSmoke();
declarePublicKnowledgeSmoke({ mode: "disabled" });

test("route coverage matches the authenticated route tree", async () => {
  await expectAuthenticatedRouteCoverage(SMOKE_ROUTE_DEFS);
  expect(
    routeScaleLedgerAdditions(),
    "route scale allowances only shrink",
  ).toEqual([]);
  const routeKeys = new Set(SMOKE_ROUTE_DEFS.map(networkBaselineKey));
  expect(
    SCALE_LEDGER.filter(({ route }) => !routeKeys.has(route)),
    "scale allowances reference smoke routes",
  ).toEqual([]);
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
    checkUnenrolledRoutes: true,
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
      checkUnenrolledRoutes: groupIndex === 0,
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
  renderResults,
  route,
}: {
  browser: Browser;
  results: Map<string, RouteNetworkMetrics>;
  // Present on the scale walk: also count React commits per navigation.
  renderResults?: Map<string, RouteRenderMetrics>;
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
      ...(renderResults === undefined ? {} : { renderResults }),
      route: {
        template: networkBaselineKey(route),
        ...(route.storageState === undefined
          ? {}
          : { storageState: route.storageState }),
        path: expectation.to,
        ...(route.settleMs === undefined ? {} : { settleMs: route.settleMs }),
        expectation: { kind: "redirectsTo", to: expectation.to },
      },
    });
    return;
  }

  await smokeRouteTarget({
    browser,
    results,
    ...(renderResults === undefined ? {} : { renderResults }),
    route,
  });
};

const smokeRouteTarget = async ({
  browser,
  results,
  renderResults,
  route,
}: {
  browser: Browser;
  results: Map<string, RouteNetworkMetrics>;
  renderResults?: Map<string, RouteRenderMetrics>;
  route: SmokeRoute;
}) => {
  const { network, renders } = await measureRouteTarget({
    browser,
    route,
    countRenders: renderResults !== undefined,
  });
  // Stored under the template it received; redirect targets arrive as
  // "<template> target".
  results.set(route.template, network);
  if (renders !== null) {
    renderResults?.set(route.template, renders);
  }
};

const measureRouteTarget = async ({
  browser,
  route,
  countRenders,
}: {
  browser: Browser;
  route: SmokeRoute;
  countRenders: boolean;
}): Promise<{
  network: RouteNetworkMetrics;
  renders: RouteRenderMetrics | null;
}> => {
  const { context, page } = await openCleanPage(browser, route.storageState);
  const browserErrors = createBrowserErrorCollector({
    tolerateColdMountWarning: true,
  });
  const detachPage = browserErrors.trackPage(page);
  const network = createNetworkCollector();
  const detachNetwork = network.trackPage(page);

  const renders = countRenders
    ? createRenderRecorder(async () => await readRenderCensus(page))
    : null;

  try {
    if (renders !== null) {
      // Installed before the first document script so React registers with it.
      await page.addInitScript(installRenderCommitHook, RENDER_CENSUS_GLOBAL);
    }
    await network.measureRounds(
      page,
      renders === null ? {} : { beforeRelease: renders.beforeRelease },
    );
    await renderSmokeRoute({ page, route });
    await network.waitForQuiet({
      idleMs: NETWORK_QUIET_MS,
      minimumObservationMs: DEFAULT_SETTLE_MS,
      // Allow injected request waves to finish; quiet activity still exits early.
      timeoutMs: Math.max(route.settleMs ?? DEFAULT_SETTLE_MS, 10_000),
    });
    network.finishRounds();
    // Commits until the network went quiet; checks below do not render.
    const renderMetrics = renders === null ? null : await renders.finish();
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
    return {
      network: summarizeCapture(await network.capture()),
      renders: renderMetrics,
    };
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
  const { context, page } = await openCleanPage(browser, route.storageState);
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
  storageState:
    | string
    | Awaited<ReturnType<APIRequestContext["storageState"]>> = STORAGE_STATE,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({ storageState });
  try {
    // Guards the clean start: the page must not inherit browser storage that
    // an earlier route wrote into a shared context.
    expect(
      storedKeys(await context.storageState()),
      "route-smoke pages must start from the seeded storage state only",
    ).toEqual(
      typeof storageState === "string"
        ? await seededStorageKeys(browser)
        : storedKeys(storageState),
    );
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
