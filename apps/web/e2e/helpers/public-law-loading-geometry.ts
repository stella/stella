import { expect } from "@playwright/test";
import type { Browser, Page, TestInfo } from "@playwright/test";

import "@tanstack/react-router";

import { setPresentationPrefs } from "./presentation-prefs";
import { captureLandmarks } from "./stable-geometry";
import { createBrowserErrorCollector } from "./test";

const VIEWPORT = { width: 1440, height: 900 };
const CASES_PATH = "/law/cases?country=cze";
const COVERAGE_PATH = "/law/coverage";
const SEARCH = "main [role=search]";
const TABLE = "[data-slot=public-law-table-frame]";
const RESULTS_LANDMARKS = {
  search: SEARCH,
  toolbar: "[data-slot=public-law-results-toolbar]",
  table: TABLE,
  header: `${TABLE} [data-slot=workspace-grid-head]`,
  firstRow: `${TABLE} [data-slot=workspace-grid-row]:has([data-slot=workspace-grid-cell])`,
};

type LandmarkException = {
  type: "data-dependent-coverage-height" | "possibly-empty-results";
  landmarks: readonly string[];
  reason: string;
};

type Surface = {
  path: string;
  entryPath: string;
  apiPath: string;
  pending: string;
  ready: string;
  landmarks: Readonly<Record<string, string>>;
  exception?: LandmarkException;
};

const SURFACES: readonly Surface[] = [
  {
    path: CASES_PATH,
    entryPath: COVERAGE_PATH,
    apiPath: "/v1/case/decisions",
    pending: `${SEARCH} [data-slot=input-face]`,
    ready: `${SEARCH} input`,
    landmarks: RESULTS_LANDMARKS,
    exception: {
      type: "possibly-empty-results",
      landmarks: ["firstRow"],
      reason: "An empty seeded corpus has no first data row.",
    },
  },
  {
    path: "/law/cze/statutes",
    entryPath: COVERAGE_PATH,
    apiPath: "/v1/law/statutes",
    pending: `${SEARCH} [data-slot=input-face]`,
    ready: `${SEARCH} input`,
    landmarks: RESULTS_LANDMARKS,
    exception: {
      type: "possibly-empty-results",
      landmarks: ["firstRow"],
      reason: "An empty seeded corpus has no first data row.",
    },
  },
  {
    path: COVERAGE_PATH,
    entryPath: CASES_PATH,
    apiPath: "/v1/case/coverage",
    pending: "[data-slot=law-coverage-pending]",
    ready: "[data-slot=law-coverage-hero]",
    landmarks: {
      heading: "main h1",
      hero: "[data-slot=law-coverage-hero]",
      navigation: "main nav",
      table: "main table",
      firstRow: "main tbody tr",
    },
    exception: {
      type: "data-dependent-coverage-height",
      landmarks: ["navigation", "table", "firstRow"],
      reason:
        "The legend and country sections depend on the jurisdictions and sources returned by the coverage read.",
    },
  },
];

const navigate = async (page: Page, href: string) =>
  await page.evaluate(async (path) => {
    const router = window.__TSR_ROUTER__;
    if (router === undefined) {
      throw new Error(
        "Public law loading measurements require a mounted router",
      );
    }
    await router.navigate({ href: path });
  }, href);

const waitForHydration = async (page: Page) =>
  await page.waitForFunction(() => {
    const router = window.__TSR_ROUTER__;
    return router !== undefined && router.state.matches.length > 0;
  });

const holdRead = async (page: Page, surface: Surface) => {
  const gate = Promise.withResolvers<undefined>();
  const isRead = (url: URL) => url.pathname === surface.apiPath;
  let requested = false;
  await page.route(isRead, async (route) => {
    if (route.request().method() === "GET") {
      requested = true;
      await gate.promise;
    }
    await route.continue();
  });
  return {
    requested: () => requested,
    release: () => gate.resolve(undefined),
    remove: async () => await page.unroute(isRead),
  };
};

const settledLandmarks = async (page: Page, surface: Surface) => {
  await expect(page.locator(surface.pending)).toHaveCount(0);
  await expect(page.locator(surface.ready)).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return await captureLandmarks(page, surface.landmarks);
};

const observeNavigation = async (page: Page, surface: Surface) => {
  await page.goto(surface.entryPath);
  await waitForHydration(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const read = await holdRead(page, surface);
  const navigation = navigate(page, surface.path);
  try {
    await expect.poll(read.requested).toBe(true);
    await expect(page.locator(surface.pending)).toBeVisible();
    const pending = await captureLandmarks(page, surface.landmarks);
    read.release();
    await navigation;
    const loaded = await settledLandmarks(page, surface);
    return { pending, loaded };
  } finally {
    read.release();
    await navigation;
    await read.remove();
  }
};

type Landmarks = Awaited<ReturnType<typeof captureLandmarks>>;

const compareOrigins = ({
  surface,
  phases,
  loaded,
}: {
  surface: Surface;
  phases: Record<"server" | "pending" | "hydrated", Landmarks>;
  loaded: Landmarks;
}) => {
  for (const [name, box] of Object.entries(loaded)) {
    const exception = surface.exception;
    if (
      exception?.landmarks.includes(name) &&
      (exception.type === "data-dependent-coverage-height" || box === null)
    ) {
      continue;
    }
    expect.soft(box, `${surface.path} loaded ${name}`).not.toBeNull();
    const origin = { top: box?.top, left: box?.left };
    for (const [phase, landmarks] of Object.entries(phases)) {
      expect
        .soft(landmarks[name], `${surface.path} ${phase} ${name}`)
        .toMatchObject(origin);
    }
  }
};

type MeasurePublicLawGeometryOptions = {
  baseURL: string;
  browser: Browser;
  locale: "en" | "cs";
  testInfo: TestInfo;
};

export const measurePublicLawGeometry = async ({
  baseURL,
  browser,
  locale,
  testInfo,
}: MeasurePublicLawGeometryOptions) => {
  const options = {
    baseURL,
    locale,
    viewport: VIEWPORT,
    reducedMotion: "reduce",
  } as const;
  const cold = await browser.newContext({
    ...options,
    javaScriptEnabled: false,
  });
  const live = await browser.newContext(options);
  const evidence = [];
  try {
    await Promise.all(
      [cold, live].map(
        async (context) =>
          await setPresentationPrefs({
            context,
            url: baseURL,
            patch: { sidebarOpen: false, visitorLocale: locale },
          }),
      ),
    );
    const serverPage = await cold.newPage();
    const page = await live.newPage();
    const errors = createBrowserErrorCollector({
      tolerateColdMountWarning: true,
    });
    const detach = errors.trackPage(page);
    try {
      for (const surface of SURFACES) {
        const serverResponse = await serverPage.goto(surface.path);
        expect(serverResponse?.ok()).toBe(true);
        await expect(serverPage.locator("html")).toHaveAttribute(
          "lang",
          locale,
        );
        await serverPage.evaluate(async () => {
          await document.fonts.ready;
        });
        const server = await captureLandmarks(serverPage, surface.landmarks);

        const { pending, loaded } = await observeNavigation(page, surface);
        const response = await page.goto(surface.path);
        expect(response?.ok()).toBe(true);
        await waitForHydration(page);
        const hydrated = await settledLandmarks(page, surface);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const phases = { server, pending, hydrated };
        evidence.push({
          route: surface.path,
          exception: surface.exception,
          ...phases,
          loaded,
        });
        compareOrigins({ surface, phases, loaded });
      }
      errors.assertEmpty(
        `unexpected browser errors with ${locale} public law loading views`,
      );
    } finally {
      detach();
    }
  } finally {
    await testInfo.attach(`public-law-loading-geometry-${locale}.json`, {
      body: JSON.stringify({ viewport: VIEWPORT, locale, evidence }, null, 2),
      contentType: "application/json",
    });
    await Promise.all([cold.close(), live.close()]);
  }
};
