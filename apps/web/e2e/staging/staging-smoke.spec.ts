import { expect, test, type Page } from "@playwright/test";

import { appShellNavigationLink } from "../helpers/app-shell";

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DIRECT_API_ORIGIN = new URL(
  process.env["E2E_API_URL"] ?? "https://api-staging.stll.app",
).origin;

// The smoke user mirrors the production default state: org owner,
// no usage entitlement row, no AI provider config. Regressions that
// only appear in that state must fail here, not in front of a user.

// RequireAIKey legitimately replaces the composer with this gate. Keep every
// staging chat smoke on one readiness contract so new assertions cannot drift.
const chatReadySurface = (page: Page) => {
  const composer = page.getByRole("textbox", {
    name: /type your question/iu,
  });
  const aiKeyGate = page
    .getByRole("heading", { name: "Connect AI provider" })
    .first();
  return composer.or(aiKeyGate);
};

// Surface browser-side failures in the test output: a client render
// crash otherwise shows up only as an opaque locator timeout, hiding
// the actual exception behind a blank page.
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    // Emptiness, not absence, is how an error reports "no stack" here, so
    // a nullish fallback would log the empty string instead of the error.
    console.log(`[pageerror] ${error.stack || String(error)}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    console.log(
      `[requestfailed] ${request.method()} ${request.url()}: ${failure}`,
    );
  });
});

test("deployed app serves the authenticated shell", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(appShellNavigationLink(page, "/chat")).toBeVisible();
  await expect(page).not.toHaveURL(/\/auth(?:\/|$)/u);
});

test("chat thread page renders for an entitlement-less owner", async ({
  page,
}) => {
  await page.goto("/chat/new", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u);

  // The route error boundary replaces the thread UI wholesale; its
  // title is the canonical signature of a client-side render crash.
  await expect(page.getByText("This page couldn’t be opened")).toBeHidden();

  await expect(chatReadySurface(page)).toBeVisible();
});

test("authenticated chat navigation stays same-origin and has no API preflights", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const optionsRequests: string[] = [];
  const directApiRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      apiRequests.push(request.url());
    }
    if (url.origin === DIRECT_API_ORIGIN) {
      directApiRequests.push(request.url());
    }
    if (
      request.method() === "OPTIONS" &&
      (url.pathname.startsWith("/api/") || url.origin === DIRECT_API_ORIGIN)
    ) {
      optionsRequests.push(request.url());
    }
  });

  await page.goto("/chat", { waitUntil: "commit" });
  await expect(chatReadySurface(page)).toBeVisible();
  expect(apiRequests.length).toBeGreaterThan(0);
  const pageOrigin = new URL(page.url()).origin;
  expect(apiRequests.every((url) => new URL(url).origin === pageOrigin)).toBe(
    true,
  );
  expect(directApiRequests).toEqual([]);
  expect(optionsRequests).toEqual([]);
});

test.describe("public hydration", () => {
  // The public shell is rendered on Linux and hydrated on the user's platform.
  // Emulating macOS catches ambient platform reads that Linux-only CI misses.
  test.use({
    locale: "pt-PT",
    timezoneId: "America/Los_Angeles",
    userAgent: MACOS_USER_AGENT,
  });

  test("server-rendered public law decisions stay stable after hydration", async ({
    page,
  }) => {
    const fixedBrowserDate = new Date();
    fixedBrowserDate.setUTCHours(2, 0, 0, 0);
    const expectedToday = new Date(fixedBrowserDate.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await page.clock.setFixedTime(fixedBrowserDate);

    // A persisted non-English locale is the harder hydration case: the
    // client holds translated messages before hydrating against the
    // server's English markup. The bug class this guards against only
    // reproduced with a non-default locale.
    // String form: the e2e tsconfig has no DOM lib, so a function body
    // referencing browser globals would not typecheck in this context.
    await page.addInitScript({
      content: `window.localStorage.setItem("sidebar_state", "collapsed");
      window.localStorage.setItem("stella-ui-theme", "light");
      window.localStorage.setItem("stella-ui-palette", "flexoki");
      window.localStorage.setItem(
        "stella-i18n",
        JSON.stringify({ state: { lang: "cs" }, version: 0 }),
      );`,
    });

    // Hydration mismatches surface as pageerrors (React #418 + a router
    // invariant) and end in the error boundary; collect them explicitly
    // so the failure names the real exception instead of a timeout.
    const pageErrors: string[] = [];
    const hydrationConsoleErrors: string[] = [];
    const failedAssets: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("console", (message) => {
      const text = message.text();
      const normalizedText = text.toLowerCase();
      if (
        message.type() === "error" &&
        (normalizedText.includes("hydrated") ||
          normalizedText.includes("hydration"))
      ) {
        hydrationConsoleErrors.push(text);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().includes("/assets/")) {
        failedAssets.push(response.url());
      }
    });

    await page.goto("/law/cases", { waitUntil: "commit" });
    // Scoped to the decisions table: the shell sidebar also carries a
    // /law/cases nav link that a page-wide href filter could match.
    const firstDecision = page
      .getByRole("table")
      .locator('a[href*="/cases/"]')
      .first();

    await expect(firstDecision).toBeVisible();
    const datePickerTrigger = page
      .getByRole("button", { name: /select date|vybrat datum/iu })
      .first();
    // The route is SSR'd, so the trigger is visible just before React has
    // attached its handler and a too-early click is dropped (same gotcha as
    // public-tools.spec.ts). Retry the open until hydration has accepted it.
    // The re-click guard reads the trigger's aria-expanded, which the
    // popover flips synchronously with its state: a successful click whose
    // grid is still mounting is not toggled shut, while the dead SSR markup
    // keeps it "false" so the pre-hydration case still retries.
    const dayGrid = page.locator('[role="gridcell"]').first();
    await expect(async () => {
      if ((await datePickerTrigger.getAttribute("aria-expanded")) !== "true") {
        await datePickerTrigger.click();
      }
      await expect(dayGrid).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(
      page.locator('[role="gridcell"][aria-current="date"]'),
    ).toHaveAttribute("data-date", expectedToday);
    await page.keyboard.press("Escape");
    await firstDecision.click();
    await expect(page).toHaveURL(/\/law\/[a-z]{2,3}\/cases\//u);

    // Force a full server-rendered load of the decision page: client-side
    // navigation alone would never exercise the hydration path that broke.
    await page.reload({ waitUntil: "commit" });

    await expect(page.locator("article").first()).toBeVisible();
    // Imported judgments are self-contained articles and may carry their own h1.
    // Assert the app-owned page title without constraining source-document markup.
    const decisionTitle = page.locator('h1[data-slot="decision-title"]');
    await expect(decisionTitle).toHaveCount(1);
    await expect(decisionTitle).toHaveText(/\S/u);
    const routeErrorTitle = page.locator("#route-error-title");
    const inspector = page.locator('[data-slot="inspector-dock"]');
    await expect(routeErrorTitle).toHaveCount(0);
    await expect(inspector).toHaveAttribute("data-state", "expanded");
    await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    await expect(page.locator("html")).toHaveClass(/\bpalette-flexoki\b/u);
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/u);

    // Authentication resolution and the lazy inspector graph settle after the
    // decision body appears. Keep observing long enough to catch a delayed
    // remount, stale-chunk retry, or cross-tab store reconciliation.
    await page.waitForTimeout(5000);
    await expect(routeErrorTitle).toHaveCount(0);
    await expect(inspector).toHaveAttribute("data-state", "expanded");
    expect(pageErrors).toEqual([]);
    expect(hydrationConsoleErrors).toEqual([]);
    expect(failedAssets).toEqual([]);
  });
});
