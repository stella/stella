import { expect, test } from "@playwright/test";

import { getStorageKey } from "../../src/consts";

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

  await expect(page).toHaveURL(/\/auth\/?$/u, { timeout: 30_000 });
  await expect
    .poll(async () =>
      page.evaluate((key) => localStorage.getItem(key), storageKey),
    )
    .not.toBe("{");
});
