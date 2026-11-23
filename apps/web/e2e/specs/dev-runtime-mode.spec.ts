import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

const PLAYGROUND_HEADING = "Stella UI Playground";

test("dev playgrounds match the web runtime mode", async ({ page }) => {
  await page.goto("/dev?visual=ui", { waitUntil: "commit" });

  if (!EXPECTS_DEV_RUNTIME) {
    // Production builds leave the dev routes out, so /dev is an unknown page.
    await expect(
      page.getByRole("heading", {
        name: "We could not find what you requested.",
      }),
    ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
    await expect(page).toHaveURL(/\/dev\?visual=ui$/u);
    await expect(
      page.getByRole("heading", { name: PLAYGROUND_HEADING }),
    ).toHaveCount(0);
    return;
  }

  await expect(page).toHaveURL(/\/dev\?visual=ui$/u);
  await expect(
    page.getByRole("heading", { name: PLAYGROUND_HEADING }),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
});
