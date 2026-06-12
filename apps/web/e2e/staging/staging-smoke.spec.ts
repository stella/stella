import { expect, test } from "@playwright/test";

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
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/auth(\/|$)/u);
});

test("chat thread page renders for an entitlement-less owner", async ({
  page,
}) => {
  await page.goto("/chat/new");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u);

  // The route error boundary replaces the thread UI wholesale; its
  // title is the canonical signature of a client-side render crash.
  await expect(page.getByText("Something went wrong")).toBeHidden();

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

test("server-rendered public law pages hydrate cleanly", async ({ page }) => {
  // Hydration mismatches surface as pageerrors (React #418 + a router
  // invariant) and end in the error boundary; collect them explicitly
  // so the failure names the real exception instead of a timeout.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/law/cases");
  const firstDecision = page
    .locator('a[href*="/law/"][href*="/cases/"]')
    .first();

  await expect(firstDecision).toBeVisible();
  await firstDecision.click();
  await expect(page).toHaveURL(/\/law\/[a-z]{2,3}\/cases\//u);

  // Force a full server-rendered load of the decision page: client-side
  // navigation alone would never exercise the hydration path that broke.
  await page.reload();

  // Case numbers look like "6 Tdo 647/2017"; anchoring on the slash-year
  // tail keeps the regex linear.
  await expect(page.getByRole("heading", { name: /\/\d{4}/u })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
