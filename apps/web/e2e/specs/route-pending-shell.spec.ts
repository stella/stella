import type { Page } from "@playwright/test";
import "@tanstack/react-router";

import { appShellNavigationLink } from "../helpers/app-shell";
import { expect, test } from "../helpers/test";

const cases = [
  { path: "/workspaces", listPath: "/v1/workspaces" },
  { path: "/contacts", listPath: "/v1/contacts" },
] as const;

const holdProtectedLoader = async (page: Page) => {
  await page.evaluate(() => {
    const router = window.__TSR_ROUTER__;
    const route = router?.routesById["/_protected"];
    const original = route?.options.loader;
    if (route === undefined || typeof original !== "function") {
      throw new Error("The production protected route loader must exist");
    }
    const gate = Promise.withResolvers<undefined>();
    window.addEventListener(
      "release-protected-loader",
      () => gate.resolve(undefined),
      {
        once: true,
      },
    );
    window.addEventListener(
      "restore-protected-loader",
      () => {
        gate.resolve(undefined);
        route.update({ loader: original });
        delete document.documentElement.dataset["parentLoaderHeld"];
      },
      { once: true },
    );
    route.update({
      loader: async (context) => {
        await original(context);
        document.documentElement.dataset["parentLoaderHeld"] = "true";
        await gate.promise;
      },
    });
  });
};

const holdRequest = async (page: Page, path: string) => {
  const gate = Promise.withResolvers<undefined>();
  let requested = false;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      requested = true;
      await gate.promise;
      await route.continue();
    },
  );
  return { requested: () => requested, release: () => gate.resolve(undefined) };
};

const expectSingleShell = async (page: Page) => {
  // The old static shell has no sidebar slot; include its visible sidebar
  // column so it cannot hide from the same census as the mounted app chrome.
  expect(
    await page
      .locator('[data-slot="sidebar"]:visible, .bg-sidebar.w-64:visible')
      .count(),
  ).toBe(1);
  // Exclude hidden wordmarks without hiding a second rendered logo.
  expect(await page.locator('svg[viewBox="0 0 573 151"]:visible').count()).toBe(
    1,
  );
};

for (const { path, listPath } of cases) {
  test(`${path} keeps one app shell throughout delayed parent and page loaders`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("sidebar_state", "expanded");
    });
    await page.goto("/knowledge", { waitUntil: "commit" });
    await expect(appShellNavigationLink(page, path)).toBeVisible({
      timeout: 30_000,
    });
    await expectSingleShell(page);
    const list = await holdRequest(page, listPath);
    const content = page.locator('[data-slot="workspace-shell-content"]');
    await holdProtectedLoader(page);

    try {
      // Navigate through the mounted app, using its real route tree and frame.
      await appShellNavigationLink(page, path).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-parent-loader-held",
        "true",
      );
      await expect.poll(list.requested).toBe(true);
      await expect(page).toHaveURL(new RegExp(`${path}/?(?:\\?.*)?$`, "u"));
      await expect(
        content.locator('[data-slot="skeleton"]').first(),
      ).toBeVisible();
      await expectSingleShell(page);

      await page.evaluate(() =>
        window.dispatchEvent(new Event("release-protected-loader")),
      );
      // The page's own disabled toolbar now proves its fallback is mounted.
      await expect(
        content.locator("input[placeholder]:disabled").first(),
      ).toBeVisible();
      await expectSingleShell(page);

      const listResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === listPath,
      );
      list.release();
      expect((await listResponse).ok()).toBe(true);
      await expect(
        content.locator("input[placeholder]:enabled").first(),
      ).toBeVisible();
      await expect(content.locator("input[placeholder]:disabled")).toHaveCount(
        0,
      );
      await expect(page).toHaveURL(new RegExp(`${path}/?(?:\\?.*)?$`, "u"));
      await expectSingleShell(page);
    } finally {
      list.release();
      await page.evaluate(() =>
        window.dispatchEvent(new Event("restore-protected-loader")),
      );
    }
  });
}
