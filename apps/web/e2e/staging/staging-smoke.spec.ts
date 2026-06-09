import { expect, test } from "@playwright/test";

// The smoke user mirrors the production default state: org owner,
// no usage entitlement row, no AI provider config. Regressions that
// only appear in that state must fail here, not in front of a user.

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
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible();
});
