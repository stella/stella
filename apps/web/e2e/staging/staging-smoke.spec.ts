import { expect, test } from "@playwright/test";

import { appShellNavigationLink } from "../helpers/app-shell";

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// The public shell is rendered on Linux and hydrated on the user's platform.
// Emulating macOS catches ambient platform reads that Linux-only CI misses.
test.use({ userAgent: MACOS_USER_AGENT });

// The smoke user mirrors the production default state: org owner,
// no usage entitlement row, no AI provider config. Regressions that
// only appear in that state must fail here, not in front of a user.

// Surface browser-side failures in the test output: a client render
// crash otherwise shows up only as an opaque locator timeout, hiding
// the actual exception behind a blank page.
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    console.log(`[pageerror] ${error.stack ?? String(error)}`);
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

  // The smoke org has no AI provider credentials, so RequireAIKey
  // legitimately gates the thread with the connect-provider card
  // instead of the composer. Either state proves the route rendered.
  // The gate renders its heading twice (inline card plus an
  // auto-opened dialog), so first() scopes to that locator only; the
  // composer keeps strict matching so a stray second composer fails.
  const composer = page.getByRole("textbox", { name: /type your question/iu });
  const aiKeyGate = page
    .getByRole("heading", { name: "Connect AI provider" })
    .first();
  await expect(composer.or(aiKeyGate)).toBeVisible();
});

test("server-rendered public law decisions stay stable after hydration", async ({
  page,
}) => {
  // A persisted non-English locale is the harder hydration case: the
  // client holds translated messages before hydrating against the
  // server's English markup. The bug class this guards against only
  // reproduced with a non-default locale.
  // String form: the e2e tsconfig has no DOM lib, so a function body
  // referencing browser globals would not typecheck in this context.
  await page.addInitScript({
    content: `window.localStorage.setItem(
      "stella-i18n",
      JSON.stringify({ state: { lang: "cs" }, version: 0 }),
    );`,
  });

  // Hydration mismatches surface as pageerrors (React #418 + a router
  // invariant) and end in the error boundary; collect them explicitly
  // so the failure names the real exception instead of a timeout.
  const pageErrors: string[] = [];
  const failedAssets: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
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
  await firstDecision.click();
  await expect(page).toHaveURL(/\/law\/[a-z]{2,3}\/cases\//u);

  // Force a full server-rendered load of the decision page: client-side
  // navigation alone would never exercise the hydration path that broke.
  await page.reload({ waitUntil: "commit" });

  await expect(page.locator("article").first()).toBeVisible();
  // Source documents may contain their own level-one heading. Scope this to
  // the viewer's accessible page title rather than assuming a global count.
  await expect(page.locator("h1.sr-only")).toHaveCount(1);
  const routeErrorTitle = page.locator("#route-error-title");
  const inspector = page.locator('[data-side="right"]');
  await expect(routeErrorTitle).toHaveCount(0);
  await expect(inspector).toHaveAttribute("data-state", "expanded");

  // Authentication resolution and the lazy inspector graph settle after the
  // decision body appears. Keep observing long enough to catch a delayed
  // remount, stale-chunk retry, or cross-tab store reconciliation.
  await page.waitForTimeout(5000);
  await expect(routeErrorTitle).toHaveCount(0);
  await expect(inspector).toHaveAttribute("data-state", "expanded");
  expect(pageErrors).toEqual([]);
  expect(failedAssets).toEqual([]);
});
