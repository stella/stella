import { expect, test } from "@playwright/test";

import { getStorageKey } from "../../src/consts";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

test.use({ storageState: { cookies: [], origins: [] } });

test("malformed persisted i18n state cannot block app bootstrap", async ({
  page,
}) => {
  const storageKey = getStorageKey("i18n");
  await page.addInitScript(
    ({ storageKey: key }) => {
      localStorage.setItem(key, "{");
    },
    { storageKey },
  );

  await page.goto("/", { waitUntil: "commit" });

  await expect(page).toHaveURL(/\/auth\/?$/u, {
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  await expect
    .poll(async () =>
      page.evaluate((key) => localStorage.getItem(key), storageKey),
    )
    .not.toBe("{");
});
