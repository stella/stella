import type { Page } from "@playwright/test";

import ar from "../../src/i18n/langs/ar.json" with { type: "json" };
import en from "../../src/i18n/langs/en.json" with { type: "json" };
import {
  defaultPresentationPrefs,
  parsePresentationPrefs,
  PRESENTATION_PREFS_COOKIE,
  serializePresentationPrefs,
} from "../../src/lib/account/presentation-prefs/preferences";
import { E2E_API_ORIGIN } from "../helpers/api";
import { createProfileTestSession } from "../helpers/profile-session";
import { expect, test } from "../helpers/test";

const sessionLocale = async (page: Page) => {
  const response = await page.request.get(
    `${E2E_API_ORIGIN}/api/auth/get-session`,
  );
  expect(response.ok()).toBe(true);
  const session = await response.json();
  return session?.user?.locale ?? null;
};

const presentationPrefs = async (page: Page) => {
  const cookie = (await page.context().cookies(page.url())).find(
    (entry) => entry.name === PRESENTATION_PREFS_COOKIE,
  );
  return cookie === undefined
    ? null
    : parsePresentationPrefs(decodeURIComponent(cookie.value));
};

const selectProfileLanguage = async (
  page: Page,
  { label, locale }: { label: "Čeština" | "العربية"; locale: "cs" | "ar" },
) => {
  await page.locator("#language-select").click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect.poll(async () => await sessionLocale(page)).toBe(locale);
  await expect
    .poll(async () => (await presentationPrefs(page))?.visitorLocale)
    .toBe(locale);
};

test("profile language and collapsed sidebar render in the first HTML response", async ({
  baseURL,
  browser,
  page,
}) => {
  const profileSession = await createProfileTestSession({
    page,
    label: "first-paint-prefs",
    webUrl: baseURL ?? "http://localhost:3000",
  });
  const route = "/law/cases?country=cze";
  const webBaseURL = baseURL ?? "http://localhost:3000";

  try {
    await page.goto("/settings/account/profile", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("#language-select")).toBeVisible();
    await selectProfileLanguage(page, { label: "Čeština", locale: "cs" });

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();
    if ((await sidebar.getAttribute("data-state")) !== "collapsed") {
      await page
        .locator('[data-slot="sidebar-header"]')
        .getByRole("button")
        .click();
    }
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect
      .poll(async () => await presentationPrefs(page))
      .toMatchObject({ sidebarOpen: false });

    const rawResponse = await page.request.get(new URL(route, webBaseURL).href);
    expect(rawResponse.ok()).toBe(true);
    const html = await rawResponse.text();
    expect(html).toMatch(/<html[^>]*\blang="cs"/u);
    expect(html).toMatch(/<span[^>]*>Judikatura<\/span>/u);
    expect(html).toMatch(
      /(?=[^>]*data-slot="sidebar")(?=[^>]*data-state="collapsed")[^>]*/u,
    );

    const storageState = await page.context().storageState();
    const serverContext = await browser.newContext({
      baseURL: webBaseURL,
      javaScriptEnabled: false,
      storageState,
      viewport: { width: 1280, height: 900 },
    });

    try {
      const serverPage = await serverContext.newPage();
      const response = await serverPage.goto(route, {
        waitUntil: "domcontentloaded",
      });
      if (!response) {
        throw new Error(
          "The no-JavaScript page navigation returned no response",
        );
      }

      await expect(
        serverPage
          .locator('[data-slot="sidebar"]')
          .getByRole("link", { name: "Judikatura", exact: true }),
      ).toHaveCount(1);
      const serverWidth = await serverPage
        .locator('[data-slot="sidebar-gap"]')
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(serverWidth).toBeGreaterThan(0);
      expect(serverWidth).toBeLessThan(100);

      await page.addInitScript(() => {
        const recordSidebarWidth = () => {
          const sidebarGap = document.querySelector(
            '[data-slot="sidebar-gap"]',
          );
          if (sidebarGap) {
            performance.mark("sidebar-first-paint-width", {
              detail: sidebarGap.getBoundingClientRect().width,
            });
            return;
          }
          requestAnimationFrame(recordSidebarWidth);
        };
        requestAnimationFrame(recordSidebarWidth);
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("lang", "cs");
      await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
        "data-state",
        "collapsed",
      );
      // Exercise a hydrated handler so server attributes alone cannot satisfy
      // the final geometry assertion.
      await page
        .locator('[data-slot="sidebar-header"]')
        .getByRole("button")
        .click();
      await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
        "data-state",
        "expanded",
      );
      await page
        .locator('[data-slot="sidebar-header"]')
        .getByRole("button")
        .click();
      await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
        "data-state",
        "collapsed",
      );
      const firstPaintWidth = await page.evaluate(() =>
        performance
          .getEntriesByName("sidebar-first-paint-width")
          .map((entry) =>
            entry instanceof PerformanceMark ? entry.detail : null,
          )
          .at(0),
      );
      expect(firstPaintWidth).toBe(serverWidth);
      await expect
        .poll(async () =>
          page
            .locator('[data-slot="sidebar-gap"]')
            .evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBe(serverWidth);

      await page.goto("/settings/account/profile", {
        waitUntil: "domcontentloaded",
      });
      await selectProfileLanguage(page, { label: "العربية", locale: "ar" });
      const rtlResponse = await page.request.get(
        new URL(route, webBaseURL).href,
      );
      expect(rtlResponse.ok()).toBe(true);
      const rtlHtml = await rtlResponse.text();
      expect(rtlHtml).toMatch(
        /<html(?=[^>]*\blang="ar")(?=[^>]*\bdir="rtl")[^>]*>/u,
      );
    } finally {
      await serverContext.close();
    }
  } finally {
    await profileSession.cleanup();
  }
});

test("a fresh visitor renders the preferred browser catalogue and explicit preference overrides it", async ({
  browser,
  baseURL,
}) => {
  const webBaseURL = baseURL ?? "http://localhost:3000";
  const context = await browser.newContext({
    baseURL: webBaseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "Accept-Language": "en;q=0.2,cs-CZ;q=0.9" },
  });
  try {
    const response = await context.request.get("/law/cases?country=cze");
    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(/<html[^>]*\blang="cs"/u);
    await context.addCookies([
      {
        name: PRESENTATION_PREFS_COOKIE,
        value: encodeURIComponent(
          serializePresentationPrefs({
            ...defaultPresentationPrefs,
            visitorLocale: "de",
          }),
        ),
        url: webBaseURL,
      },
    ]);
    const explicitResponse = await context.request.get(
      "/law/cases?country=cze",
    );
    expect(explicitResponse.ok()).toBe(true);
    expect(await explicitResponse.text()).toMatch(/<html[^>]*\blang="de"/u);
  } finally {
    await context.close();
  }
});

for (const { language, sundayBasedWeekStart } of [
  { language: "ar-SA", sundayBasedWeekStart: 0 },
  { language: "ar-AE", sundayBasedWeekStart: 1 },
]) {
  test(`fresh ${language} visitors retain regional formatting through hydration`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL: baseURL ?? "http://localhost:3000",
      locale: language,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { "Accept-Language": `en;q=0.2,${language};q=0.9` },
    });
    try {
      const page = await context.newPage();
      const response = await page.goto("/law/cases?country=cze", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.ok()).toBe(true);
      const html = await response?.text();
      expect(html).toMatch(
        /<html(?=[^>]*\blang="ar")(?=[^>]*\bdir="rtl")[^>]*>/u,
      );
      // SSR controls are visible while their route chunks are still loading.
      // Router matches commit after asynchronous hydration.
      await page.waitForFunction(() => {
        const router = window.__TSR_ROUTER__;
        return router !== undefined && router.state.matches.length > 0;
      });
      // Opening the filters and calendar requires hydrated event handlers.
      const filters = page.getByRole("button", {
        name: ar.common.filters,
        exact: true,
      });
      await filters.click();
      await expect(filters).toHaveAttribute("aria-expanded", "true");
      await page
        .getByRole("button", {
          name: `${ar.search.dateFrom} ${ar.common.selectDate}`,
          exact: true,
        })
        .click();
      const calendar = page.locator('[data-slot="date-picker-popup"]');
      await expect(calendar).toBeVisible();
      const formattingLocale = `${language}-u-ca-gregory-nu-arab`;
      const expectedWeekday = new Intl.DateTimeFormat(formattingLocale, {
        weekday: "short",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2026, 0, 4 + sundayBasedWeekStart)));
      await expect(
        calendar.locator('[role="row"][aria-hidden="true"] > span').first(),
      ).toHaveText(expectedWeekday);
    } finally {
      await context.close();
    }
  });
}

test("overlapping preference changes survive reload and update another mounted tab", async ({
  page,
  baseURL,
  browserErrors,
}) => {
  const context = page.context();
  await context.addCookies([
    {
      name: PRESENTATION_PREFS_COOKIE,
      value: encodeURIComponent(
        serializePresentationPrefs({
          ...defaultPresentationPrefs,
          theme: "light",
        }),
      ),
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
  const peer = await context.newPage();
  const stopTracking = browserErrors.trackPage(peer);
  const themeGate = Promise.withResolvers<undefined>();
  let themeHeld = false;
  await page.route("**/_serverFn/**", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postData()?.includes('"theme"')
    ) {
      themeHeld = true;
      await themeGate.promise;
    }
    await route.continue();
  });
  try {
    await Promise.all([
      page.goto("/chat", { waitUntil: "domcontentloaded" }),
      peer.goto("/chat", { waitUntil: "domcontentloaded" }),
    ]);
    await page
      .locator('[data-slot="sidebar-footer"] button[aria-haspopup="menu"]')
      .last()
      .click();
    await page
      .getByRole("menuitem", { name: en.appearance.title, exact: true })
      .hover();
    await page
      .getByRole("menuitemradio", { name: en.appearance.dark, exact: true })
      .click();
    await expect.poll(() => themeHeld).toBe(true);
    await peer
      .locator('[data-slot="sidebar-header"]')
      .getByRole("button")
      .click();
    await expect(peer.locator('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    themeGate.resolve(undefined);
    await expect
      .poll(async () => await presentationPrefs(page))
      .toMatchObject({ theme: "dark", sidebarOpen: false });
    // Both tabs stay mounted while their queued writes settle.
    await expect(peer.locator("html")).toHaveClass(/dark/u);
    for (const tab of [page, peer]) {
      await tab.reload({ waitUntil: "domcontentloaded" });
      await expect(tab.locator("html")).toHaveClass(/dark/u);
      await expect(tab.locator('[data-slot="sidebar"]')).toHaveAttribute(
        "data-state",
        "collapsed",
      );
    }
    await page
      .locator('[data-slot="sidebar-footer"] button[aria-haspopup="menu"]')
      .last()
      .click();
    await page
      .getByRole("menuitem", { name: en.appearance.title, exact: true })
      .hover();
    await page
      .getByRole("menuitemradio", { name: en.appearance.light, exact: true })
      .click();
    // B makes no write or navigation here; only the broadcast can update it.
    await expect(peer.locator("html")).not.toHaveClass(/dark/u);
  } finally {
    themeGate.resolve(undefined);
    stopTracking();
    await peer.close();
  }
});
